/**
 * Salesforce — REST API through a Connected App, OAuth 2.0 client-credentials flow.
 * Calls are booked as Events on the Contact or Lead; a caller who does not book becomes a Lead.
 *
 * UNVERIFIED: standard objects only (Lead, Contact, Event, Opportunity). Orgs with required
 * custom fields or validation rules will need a field mapping.
 */
import { ConnectorContext, ConnectorError, CrmConnector, expectOk, national10, splitName } from "../types.js";

const V = "v61.0";

async function session(ctx: ConnectorContext): Promise<{ token: string; instance: string }> {
  const cached = ctx.cache.get<{ token: string; instance: string }>("session");
  if (cached) return cached;
  const { clientId, clientSecret } = ctx.credentials;
  const domain = String(ctx.settings.instanceUrl || "").replace(/\/+$/, "");
  if (!clientId || !clientSecret || !/^https:\/\/[\w.-]+\.salesforce\.com$/i.test(domain)) {
    throw new ConnectorError("Salesforce needs a consumer key, consumer secret and the org's My Domain URL (https://….my.salesforce.com).");
  }
  const res = await ctx.http({
    method: "POST", url: `${domain}/services/oauth2/token`, headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = expectOk(res, "Salesforce sign-in");
  const s = { token: data.access_token, instance: String(data.instance_url || domain).replace(/\/+$/, "") };
  ctx.cache.set("session", s, 30 * 60);
  return s;
}

async function call(ctx: ConnectorContext, method: any, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  const s = await session(ctx);
  const res = await ctx.http({ method, url: `${s.instance}/services/data/${V}${path}`, headers: { authorization: `Bearer ${s.token}` }, query: opts.query, body: opts.body });
  return expectOk(res, `Salesforce ${method} ${path.split("?")[0]}`);
}

/** SOQL string literal. The value is digits only by construction, escaped anyway. */
const lit = (s: string) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

async function soql(ctx: ConnectorContext, query: string): Promise<any[]> {
  return (await call(ctx, "GET", "/query", { query: { q: query } }))?.records || [];
}

export const salesforce: CrmConnector = {
  kind: "salesforce",
  label: "Salesforce",
  maturity: "unverified",
  credentialFields: [
    { key: "clientId", label: "Consumer key", required: true },
    { key: "clientSecret", label: "Consumer secret", secret: true, required: true },
  ],
  settingFields: [{ key: "instanceUrl", label: "My Domain URL", required: true, help: "https://yourcompany.my.salesforce.com" }],
  accessNote: "The client's Salesforce admin installs a Connected App with the client-credentials flow enabled and a run-as user.",

  async test(ctx) {
    await call(ctx, "GET", "/limits");
  },

  async lookupCustomer(ctx, phone) {
    const like = lit("%" + national10(phone));
    const contacts = await soql(ctx, `SELECT Id, Name, Email, Phone, MobilePhone, MailingStreet, MailingCity, MailingState, MailingPostalCode FROM Contact WHERE Phone LIKE ${like} OR MobilePhone LIKE ${like} LIMIT 1`);
    if (contacts[0]) {
      const c = contacts[0];
      return { externalId: c.Id, name: c.Name || "", phone, email: c.Email || undefined, address: { street: c.MailingStreet, city: c.MailingCity, state: c.MailingState, postalCode: c.MailingPostalCode } };
    }
    const leads = await soql(ctx, `SELECT Id, Name, Email, Street, City, State, PostalCode FROM Lead WHERE IsConverted = false AND (Phone LIKE ${like} OR MobilePhone LIKE ${like}) LIMIT 1`);
    if (!leads[0]) return null;
    const l = leads[0];
    return { externalId: l.Id, name: l.Name || "", phone, email: l.Email || undefined, address: { street: l.Street, city: l.City, state: l.State, postalCode: l.PostalCode } };
  },

  async getAvailability() {
    return null;
  },

  async bookJob(ctx, input) {
    let whoId = input.externalCustomerId || "";
    if (!whoId) whoId = (await salesforce.createLead(ctx, { customer: input.customer, summary: input.notes || input.jobType, source: input.source })).externalId;
    const ev = await call(ctx, "POST", "/sobjects/Event", {
      body: { Subject: input.jobType, StartDateTime: input.start.toISOString(), EndDateTime: input.end.toISOString(), WhoId: whoId, Description: input.notes || "" },
    });
    return { externalJobId: String(ev.id), externalCustomerId: whoId };
  },

  async reschedule(ctx, input) {
    await call(ctx, "PATCH", `/sobjects/Event/${encodeURIComponent(input.externalJobId)}`, { body: { StartDateTime: input.start.toISOString(), EndDateTime: input.end.toISOString() } });
  },

  async cancel(ctx, input) {
    await call(ctx, "DELETE", `/sobjects/Event/${encodeURIComponent(input.externalJobId)}`);
  },

  async createLead(ctx, input) {
    const n = splitName(input.customer.name);
    const a = input.customer.address || {};
    const lead = await call(ctx, "POST", "/sobjects/Lead", {
      body: {
        FirstName: n.first || undefined, LastName: n.last || n.first || "Unknown", Company: input.customer.name || "Homeowner",
        Phone: input.customer.phone, Email: input.customer.email || undefined, LeadSource: input.source || "Phone Inquiry",
        Description: input.summary.slice(0, 30_000), Street: a.street, City: a.city, State: a.state, PostalCode: a.postalCode,
      },
    });
    return { externalId: String(lead.id) };
  },

  async getEstimates(ctx, externalCustomerId) {
    if (!externalCustomerId.startsWith("003")) return []; // only Contacts have opportunities
    const rows = await soql(ctx, `SELECT Id, Name, Amount, StageName, CreatedDate FROM Opportunity WHERE IsClosed = false AND ContactId = ${lit(externalCustomerId)} LIMIT 10`);
    return rows.map((o: any) => ({ externalId: o.Id, title: o.Name, amountCents: Math.round(Number(o.Amount || 0) * 100), status: o.StageName, createdAt: o.CreatedDate }));
  },

  async getMembership() {
    return null;
  },
};
