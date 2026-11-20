/**
 * ServiceTitan — REST v2, OAuth 2.0 client credentials per client tenant, plus our app key.
 * Tokens live about 15 minutes, so they are cached and refreshed here.
 *
 * UNVERIFIED: written from ServiceTitan's published API reference. The developer portal needs an
 * approved app, which we do not have yet — expect field-level fixes on the first real tenant.
 */
import { ConnectorContext, ConnectorError, CrmConnector, expectOk, national10 } from "../types.js";

const AUTH = (env: string) => (env === "integration" ? "https://auth-integration.servicetitan.io" : "https://auth.servicetitan.io");
const API = (env: string) => (env === "integration" ? "https://api-integration.servicetitan.io" : "https://api.servicetitan.io");

async function token(ctx: ConnectorContext): Promise<string> {
  const cached = ctx.cache.get<string>("token");
  if (cached) return cached;
  const { clientId, clientSecret } = ctx.credentials;
  if (!clientId || !clientSecret) throw new ConnectorError("ServiceTitan client id and secret are required.");
  const res = await ctx.http({
    method: "POST", url: `${AUTH(ctx.settings.environment)}/connect/token`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = expectOk(res, "ServiceTitan sign-in");
  // Refresh a minute before expiry.
  ctx.cache.set("token", data.access_token, Math.max(60, Number(data.expires_in || 900) - 60));
  return data.access_token;
}

async function call(ctx: ConnectorContext, method: any, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  const tenant = ctx.settings.tenantId;
  if (!tenant) throw new ConnectorError("ServiceTitan tenant id is required.");
  const res = await ctx.http({
    method, url: `${API(ctx.settings.environment)}${path.replace("{tenant}", encodeURIComponent(tenant))}`,
    headers: { authorization: `Bearer ${await token(ctx)}`, "ST-App-Key": ctx.credentials.appKey || "" },
    query: opts.query, body: opts.body,
  });
  return expectOk(res, `ServiceTitan ${method} ${path.split("/").slice(-1)[0]}`);
}

function jobTypeId(ctx: ConnectorContext, jobType: string): number {
  const map = ctx.settings.jobTypes || {};
  const hit = Object.keys(map).find((k) => k.toLowerCase() === String(jobType).toLowerCase());
  const id = Number(hit ? map[hit] : ctx.settings.defaultJobTypeId);
  if (!id) throw new ConnectorError(`No ServiceTitan job type is mapped for "${jobType}". Map it in the integration settings.`);
  return id;
}

export const servicetitan: CrmConnector = {
  kind: "servicetitan",
  label: "ServiceTitan",
  maturity: "unverified",
  credentialFields: [
    { key: "clientId", label: "Client ID", required: true },
    { key: "clientSecret", label: "Client secret", secret: true, required: true },
    { key: "appKey", label: "App key (ST-App-Key)", secret: true, required: true, help: "From our app in the ServiceTitan developer portal." },
  ],
  settingFields: [
    { key: "tenantId", label: "Tenant ID", required: true },
    { key: "businessUnitId", label: "Business unit ID", required: true },
    { key: "defaultJobTypeId", label: "Default job type ID", required: true },
    { key: "campaignId", label: "Campaign ID (call source)", required: true },
    { key: "environment", label: "Environment (production or integration)" },
  ],
  accessNote: "Our app must be approved by ServiceTitan, and the client's admin must connect it and generate credentials.",

  async test(ctx) {
    await call(ctx, "GET", "/settings/v2/tenant/{tenant}/business-units", { query: { pageSize: 1 } });
  },

  async lookupCustomer(ctx, phone) {
    const data = await call(ctx, "GET", "/crm/v2/tenant/{tenant}/customers", { query: { phone: national10(phone), pageSize: 1, active: "True" } });
    const c = data?.data?.[0];
    if (!c) return null;
    const a = c.address || {};
    return { externalId: String(c.id), name: c.name || "", phone, address: { street: a.street, city: a.city, state: a.state, postalCode: a.zip } };
  },

  async getAvailability(ctx, query) {
    const data = await call(ctx, "POST", "/dispatch/v2/tenant/{tenant}/capacity", {
      body: {
        startsOnOrAfter: query.from.toISOString(), endsOnOrBefore: query.to.toISOString(),
        businessUnitIds: [Number(ctx.settings.businessUnitId)], jobTypeId: jobTypeId(ctx, query.jobType), skillBasedAvailability: true,
      },
    });
    return (data?.availabilities || [])
      .filter((a: any) => a.isAvailable)
      .map((a: any) => ({ start: new Date(a.startUtc || a.start), end: new Date(a.endUtc || a.end) }))
      .filter((s: any) => !Number.isNaN(s.start.getTime()) && !Number.isNaN(s.end.getTime()));
  },

  async bookJob(ctx, input) {
    let customerId = input.externalCustomerId ? Number(input.externalCustomerId) : 0;
    let locationId = 0;
    const a = input.customer.address || {};
    const address = { street: a.street || "Unknown", city: a.city || "", state: a.state || "", zip: a.postalCode || "", country: "USA" };
    if (!customerId) {
      const created = await call(ctx, "POST", "/crm/v2/tenant/{tenant}/customers", {
        body: {
          name: input.customer.name || "New customer", type: "Residential", address,
          locations: [{ name: input.customer.name || "Home", address }],
          contacts: [{ type: "MobilePhone", value: national10(input.customer.phone) }, ...(input.customer.email ? [{ type: "Email", value: input.customer.email }] : [])],
        },
      });
      customerId = Number(created.id);
      locationId = Number(created.locations?.[0]?.id || 0);
    }
    if (!locationId) {
      const locs = await call(ctx, "GET", "/crm/v2/tenant/{tenant}/locations", { query: { customerId, pageSize: 1 } });
      locationId = Number(locs?.data?.[0]?.id || 0);
      if (!locationId) throw new ConnectorError("The ServiceTitan customer has no service location.");
    }
    const job = await call(ctx, "POST", "/jpm/v2/tenant/{tenant}/jobs", {
      body: {
        customerId, locationId, businessUnitId: Number(ctx.settings.businessUnitId), jobTypeId: jobTypeId(ctx, input.jobType),
        priority: "Normal", campaignId: Number(ctx.settings.campaignId), summary: input.notes || input.jobType,
        appointments: [{ start: input.start.toISOString(), end: input.end.toISOString(), arrivalWindowStart: input.start.toISOString(), arrivalWindowEnd: input.end.toISOString() }],
      },
    });
    return { externalJobId: String(job.id), externalCustomerId: String(customerId) };
  },

  async reschedule(ctx, input) {
    const job = await call(ctx, "GET", `/jpm/v2/tenant/{tenant}/jobs/${encodeURIComponent(input.externalJobId)}`);
    const apptId = job?.firstAppointmentId || job?.lastAppointmentId;
    if (!apptId) throw new ConnectorError("The ServiceTitan job has no appointment to move.");
    await call(ctx, "PATCH", `/jpm/v2/tenant/{tenant}/appointments/${apptId}/reschedule`, {
      body: { start: input.start.toISOString(), end: input.end.toISOString(), arrivalWindowStart: input.start.toISOString(), arrivalWindowEnd: input.end.toISOString() },
    });
  },

  async cancel(ctx, input) {
    const reasonId = Number(ctx.settings.cancelReasonId);
    if (!reasonId) throw new ConnectorError("Set a ServiceTitan cancel reason id in the integration settings to cancel jobs.");
    await call(ctx, "PUT", `/jpm/v2/tenant/{tenant}/jobs/${encodeURIComponent(input.externalJobId)}/cancel`, { body: { reasonId, memo: input.reason || "Cancelled by phone" } });
  },

  async createLead(ctx, input) {
    const lead = await call(ctx, "POST", "/crm/v2/tenant/{tenant}/leads", {
      body: {
        summary: input.summary.slice(0, 2000), campaignId: Number(ctx.settings.campaignId), businessUnitId: Number(ctx.settings.businessUnitId),
        priority: "Normal", callReasonId: ctx.settings.callReasonId ? Number(ctx.settings.callReasonId) : undefined,
      },
    });
    return { externalId: String(lead.id) };
  },

  async getEstimates(ctx, externalCustomerId) {
    const data = await call(ctx, "GET", "/sales/v2/tenant/{tenant}/estimates", { query: { customerId: externalCustomerId, status: "Open", pageSize: 10 } });
    return (data?.data || []).map((e: any) => ({
      externalId: String(e.id), title: e.name || e.summary || "Estimate", amountCents: Math.round(Number(e.subtotal || 0) * 100),
      status: e.status?.name || "Open", createdAt: e.createdOn,
    }));
  },

  async getMembership(ctx, externalCustomerId) {
    const data = await call(ctx, "GET", "/memberships/v2/tenant/{tenant}/memberships", { query: { customerIds: externalCustomerId, status: "Active", pageSize: 1 } });
    const m = data?.data?.[0];
    return m ? { externalId: String(m.id), name: m.membershipTypeName || "Membership", status: m.status || "Active", expiresAt: m.to || undefined } : null;
  },
};
