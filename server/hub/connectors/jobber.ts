/**
 * Jobber — GraphQL API with OAuth 2.0. Access tokens last 60 minutes; the refresh token ROTATES
 * on every use, so the new one is persisted before the access token is used.
 *
 * UNVERIFIED: written from Jobber's published GraphQL schema; not yet run against a real account.
 * Queries are kept small — Jobber meters query cost (10,000 points, restoring 500 per second).
 */
import { ConnectorContext, ConnectorError, CrmConnector, expectOk, national10, splitName } from "../types.js";

const GRAPHQL = "https://api.getjobber.com/api/graphql";
const TOKEN = "https://api.getjobber.com/api/oauth/token";
const VERSION = "2025-01-20";

async function token(ctx: ConnectorContext): Promise<string> {
  const cached = ctx.cache.get<string>("token");
  if (cached) return cached;
  const { clientId, clientSecret, refreshToken } = ctx.credentials;
  if (!clientId || !clientSecret || !refreshToken) throw new ConnectorError("Jobber needs a client id, client secret and refresh token.");
  const res = await ctx.http({ method: "POST", url: TOKEN, body: { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken } });
  const data = expectOk(res, "Jobber sign-in");
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await ctx.saveCredentials({ refreshToken: data.refresh_token });
    ctx.credentials.refreshToken = data.refresh_token;
  }
  ctx.cache.set("token", data.access_token, 50 * 60);
  return data.access_token;
}

async function gql(ctx: ConnectorContext, query: string, variables: Record<string, any> = {}): Promise<any> {
  const res = await ctx.http({
    method: "POST", url: GRAPHQL,
    headers: { authorization: `Bearer ${await token(ctx)}`, "X-JOBBER-GRAPHQL-VERSION": ctx.settings.apiVersion || VERSION },
    body: { query, variables },
  });
  const data = expectOk(res, "Jobber request");
  if (data?.errors?.length) {
    const throttled = data.errors.some((e: any) => e?.extensions?.code === "THROTTLED");
    throw new ConnectorError("Jobber: " + data.errors.map((e: any) => e.message).join("; ").slice(0, 300), { retryable: throttled });
  }
  return data.data;
}

/** Jobber mutations report problems in `userErrors`, not as GraphQL errors. */
function userErrors(payload: any, what: string): void {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new ConnectorError(`Jobber could not ${what}: ${errs.map((e: any) => e.message).join("; ").slice(0, 300)}`);
}

export const jobber: CrmConnector = {
  kind: "jobber",
  label: "Jobber",
  maturity: "unverified",
  credentialFields: [
    { key: "clientId", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client secret", secret: true, required: true },
    { key: "refreshToken", label: "Refresh token", secret: true, required: true, help: "Issued when the client's admin authorises our app." },
  ],
  accessNote: "A private Jobber app works for up to 5 paying accounts without review; a marketplace listing needs Jobber App Review.",

  async test(ctx) {
    await gql(ctx, "query { account { id name } }");
  },

  async lookupCustomer(ctx, phone) {
    const data = await gql(ctx,
      "query($q: String!) { clients(first: 5, searchTerm: $q) { nodes { id name phones { number } emails { address } billingAddress { street city province postalCode } } } }",
      { q: national10(phone) });
    const want = national10(phone);
    const c = (data?.clients?.nodes || []).find((x: any) => (x.phones || []).some((p: any) => national10(p.number) === want));
    if (!c) return null;
    const a = c.billingAddress || {};
    return { externalId: c.id, name: c.name || "", phone, email: c.emails?.[0]?.address, address: { street: a.street, city: a.city, state: a.province, postalCode: a.postalCode } };
  },

  async getAvailability() {
    // Jobber has no capacity endpoint: the hub offers business-hours windows minus our own bookings.
    return null;
  },

  async bookJob(ctx, input) {
    let clientId = input.externalCustomerId || "";
    let propertyId = "";
    const a = input.customer.address || {};
    if (!clientId) {
      const n = splitName(input.customer.name);
      const data = await gql(ctx,
        "mutation($input: ClientCreateInput!) { clientCreate(input: $input) { client { id properties { id } } userErrors { message } } }",
        { input: {
          firstName: n.first || "New", lastName: n.last || "Customer",
          phones: [{ number: input.customer.phone, primary: true, description: "MOBILE" }],
          emails: input.customer.email ? [{ address: input.customer.email, primary: true, description: "MAIN" }] : [],
          properties: a.street ? [{ address: { street1: a.street, city: a.city || "", province: a.state || "", postalCode: a.postalCode || "", country: "US" } }] : [],
        } });
      userErrors(data?.clientCreate, "create the client");
      clientId = data.clientCreate.client.id;
      propertyId = data.clientCreate.client.properties?.[0]?.id || "";
    }
    const data = await gql(ctx,
      "mutation($input: RequestCreateInput!) { requestCreate(input: $input) { request { id } userErrors { message } } }",
      { input: {
        clientId, propertyId: propertyId || undefined, title: input.jobType,
        requestDetails: { form: { sections: [{ label: "Details", answers: [{ label: "Notes", value: input.notes || input.jobType }] }] } },
        assessment: { schedule: { startAt: input.start.toISOString(), endAt: input.end.toISOString() }, instructions: input.notes || "" },
      } });
    userErrors(data?.requestCreate, "create the request");
    return { externalJobId: data.requestCreate.request.id, externalCustomerId: clientId };
  },

  async reschedule(ctx, input) {
    const data = await gql(ctx,
      "mutation($id: EncodedId!, $input: AssessmentEditInput!) { assessmentEdit(requestId: $id, input: $input) { assessment { id } userErrors { message } } }",
      { id: input.externalJobId, input: { schedule: { startAt: input.start.toISOString(), endAt: input.end.toISOString() } } });
    userErrors(data?.assessmentEdit, "move the appointment");
  },

  async cancel(ctx, input) {
    const data = await gql(ctx,
      "mutation($id: EncodedId!) { requestArchive(requestId: $id) { request { id } userErrors { message } } }",
      { id: input.externalJobId });
    userErrors(data?.requestArchive, "cancel the request");
  },

  async createLead(ctx, input) {
    const n = splitName(input.customer.name);
    const c = await gql(ctx,
      "mutation($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } userErrors { message } } }",
      { input: { firstName: n.first || "New", lastName: n.last || "Lead", isLead: true, phones: [{ number: input.customer.phone, primary: true, description: "MOBILE" }] } });
    userErrors(c?.clientCreate, "create the lead");
    return { externalId: c.clientCreate.client.id };
  },

  async getEstimates(ctx, externalCustomerId) {
    const data = await gql(ctx,
      "query($id: EncodedId!) { client(id: $id) { quotes(first: 10) { nodes { id title quoteStatus amounts { total } createdAt } } } }",
      { id: externalCustomerId });
    return (data?.client?.quotes?.nodes || [])
      .filter((x: any) => /draft|awaiting|changes/i.test(String(x.quoteStatus || "")))
      .map((x: any) => ({ externalId: x.id, title: x.title || "Quote", amountCents: Math.round(Number(x.amounts?.total || 0) * 100), status: x.quoteStatus, createdAt: x.createdAt }));
  },

  async getMembership() {
    return null;
  },
};
