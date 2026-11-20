/**
 * The remaining schedule connectors: the built-in calendar, AccuLynx, a client's own REST
 * endpoint, Google Calendar and Outlook.
 */
import { candidateSlots, subtractBusy } from "../slots.js";
import { ConnectorContext, ConnectorError, CrmConnector, expectOk, national10, splitName } from "../types.js";

// ── built-in ──────────────────────────────────────────────────────────────────

/**
 * No external system: customers and the schedule live in this platform. The hub keeps the
 * customers and bookings tables for every connector, so there is nothing left to do here.
 */
export const native: CrmConnector = {
  kind: "native",
  label: "Pine AI calendar",
  maturity: "live",
  credentialFields: [],
  async test() {},
  async lookupCustomer() { return null; },
  async getAvailability() { return null; },
  async bookJob(_ctx, input) {
    return { externalJobId: "", externalCustomerId: input.externalCustomerId || "" };
  },
  async reschedule() {},
  async cancel() {},
  async createLead() { return { externalId: "" }; },
  async getEstimates() { return []; },
  async getMembership() { return null; },
};

// ── AccuLynx (roofing) ────────────────────────────────────────────────────────

const ACCULYNX = "https://api.acculynx.com/api/v2";

async function acx(ctx: ConnectorContext, method: any, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  if (!ctx.credentials.apiKey) throw new ConnectorError("AccuLynx API key is required.");
  const res = await ctx.http({ method, url: ACCULYNX + path, headers: { authorization: `Bearer ${ctx.credentials.apiKey}` }, query: opts.query, body: opts.body });
  return expectOk(res, `AccuLynx ${method} ${path}`);
}

/**
 * UNVERIFIED: written from AccuLynx's published API. Booking sets the job's INITIAL appointment —
 * AccuLynx has no general calendar write — and appointment times must be UTC.
 */
export const acculynx: CrmConnector = {
  kind: "acculynx",
  label: "AccuLynx",
  maturity: "unverified",
  credentialFields: [{ key: "apiKey", label: "API key", secret: true, required: true, help: "my.acculynx.com/apikeys in the client's account." }],
  accessNote: "As a third-party integrator we must also request access from AccuLynx (their form) before a client's key works for us.",

  async test(ctx) {
    await acx(ctx, "GET", "/company-settings/job-file-settings/trade-types");
  },

  async lookupCustomer(ctx, phone) {
    const data = await acx(ctx, "POST", "/contacts/search", { body: { searchTerm: national10(phone), pageSize: 5 } });
    const c = (data?.items || [])[0];
    if (!c) return null;
    const a = c.mailingAddress || {};
    return {
      externalId: String(c.id), name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "", phone,
      email: c.emailAddresses?.[0]?.address, address: { street: a.street1, city: a.city, state: a.state?.abbreviation || a.state, postalCode: a.zipCode },
    };
  },

  async getAvailability() {
    return null;
  },

  async bookJob(ctx, input) {
    let contactId = input.externalCustomerId || "";
    const a = input.customer.address || {};
    if (!contactId) {
      const n = splitName(input.customer.name);
      // Create Job needs an existing contact.
      const c = await acx(ctx, "POST", "/contacts", {
        body: {
          firstName: n.first || "New", lastName: n.last || "Customer", contactTypeIds: ctx.settings.contactTypeId ? [ctx.settings.contactTypeId] : undefined,
          phoneNumbers: [{ number: national10(input.customer.phone), type: "Mobile", isPrimary: true }],
          emailAddresses: input.customer.email ? [{ address: input.customer.email, isPrimary: true }] : undefined,
          mailingAddress: a.street ? { street1: a.street, city: a.city, state: a.state, zipCode: a.postalCode, country: "US" } : undefined,
        },
      });
      contactId = String(c.id);
    }
    const job = await acx(ctx, "POST", "/jobs", {
      body: {
        contact: { id: contactId }, notes: input.notes || input.jobType,
        locationAddress: a.street ? { street1: a.street, city: a.city, state: a.state, zipCode: a.postalCode, country: "US" } : undefined,
        leadSource: ctx.settings.leadSourceId ? { id: ctx.settings.leadSourceId } : undefined,
      },
    });
    await acx(ctx, "PUT", `/jobs/${encodeURIComponent(job.id)}/initial-appointment`, { body: { startDate: input.start.toISOString(), endDate: input.end.toISOString(), notes: input.notes || "" } });
    return { externalJobId: String(job.id), externalCustomerId: contactId };
  },

  async reschedule(ctx, input) {
    await acx(ctx, "PUT", `/jobs/${encodeURIComponent(input.externalJobId)}/initial-appointment`, { body: { startDate: input.start.toISOString(), endDate: input.end.toISOString() } });
  },

  async cancel() {
    throw new ConnectorError("AccuLynx does not allow an appointment to be cancelled through its API. The office has been notified to cancel it there.");
  },

  async createLead(ctx, input) {
    // In AccuLynx a lead IS a job without an appointment.
    const n = splitName(input.customer.name);
    const c = await acx(ctx, "POST", "/contacts", { body: { firstName: n.first || "New", lastName: n.last || "Lead", phoneNumbers: [{ number: national10(input.customer.phone), type: "Mobile", isPrimary: true }] } });
    const job = await acx(ctx, "POST", "/jobs", { body: { contact: { id: c.id }, notes: input.summary.slice(0, 4000) } });
    return { externalId: String(job.id) };
  },

  async getEstimates() { return []; },
  async getMembership() { return null; },
};

// ── a client's own system ─────────────────────────────────────────────────────

/**
 * Generic REST: the client exposes ONE endpoint; we POST `{ "action": "<tool>", ... }` with a
 * shared secret in `x-api-key`. The contract is ours (docs/INTEGRATIONS.md), so this connector
 * is exercised end to end by the test suite against a local HTTP server.
 */
async function generic(ctx: ConnectorContext, action: string, payload: Record<string, any>): Promise<any> {
  const url = String(ctx.settings.endpointUrl || "");
  if (!/^https:\/\//i.test(url) && !(process.env.NODE_ENV !== "production" && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url))) {
    throw new ConnectorError("The endpoint must be an https:// address.");
  }
  const res = await ctx.http({ method: "POST", url, headers: { "x-api-key": ctx.credentials.apiKey || "" }, body: { action, ...payload }, timeoutMs: 8000 });
  return expectOk(res, `Client endpoint (${action})`);
}

export const genericRest: CrmConnector = {
  kind: "generic_rest",
  label: "Custom REST endpoint",
  maturity: "live",
  credentialFields: [{ key: "apiKey", label: "Shared secret", secret: true, required: true, help: "Sent as the x-api-key header on every request." }],
  settingFields: [{ key: "endpointUrl", label: "Endpoint URL", required: true }],

  async test(ctx) {
    await generic(ctx, "ping", {});
  },
  async lookupCustomer(ctx, phone) {
    const d = await generic(ctx, "lookup_customer", { phone });
    const c = d?.customer;
    if (!c?.id) return null;
    return { externalId: String(c.id), name: String(c.name || ""), phone, email: c.email || undefined, address: c.address || undefined, notes: c.notes || undefined };
  },
  async getAvailability(ctx, query) {
    const d = await generic(ctx, "get_availability", { from: query.from.toISOString(), to: query.to.toISOString(), jobType: query.jobType, postalCode: query.postalCode || "", durationMinutes: query.durationMinutes });
    if (!Array.isArray(d?.slots)) return null;
    return d.slots.map((s: any) => ({ start: new Date(s.start), end: new Date(s.end) })).filter((s: any) => !Number.isNaN(s.start.getTime()) && !Number.isNaN(s.end.getTime()));
  },
  async bookJob(ctx, input) {
    const d = await generic(ctx, "book_job", {
      customerId: input.externalCustomerId || null, customer: input.customer, jobType: input.jobType,
      start: input.start.toISOString(), end: input.end.toISOString(), notes: input.notes || "", idempotencyKey: input.idempotencyKey,
    });
    if (!d?.jobId) throw new ConnectorError("The client endpoint did not return a jobId.");
    return { externalJobId: String(d.jobId), externalCustomerId: String(d.customerId || input.externalCustomerId || "") };
  },
  async reschedule(ctx, input) {
    await generic(ctx, "reschedule", { jobId: input.externalJobId, start: input.start.toISOString(), end: input.end.toISOString() });
  },
  async cancel(ctx, input) {
    await generic(ctx, "cancel", { jobId: input.externalJobId, reason: input.reason || "" });
  },
  async createLead(ctx, input) {
    const d = await generic(ctx, "create_lead", { customer: input.customer, summary: input.summary, source: input.source || "" });
    return { externalId: String(d?.leadId || "") };
  },
  async getEstimates(ctx, externalCustomerId) {
    const d = await generic(ctx, "get_estimates", { customerId: externalCustomerId });
    return (Array.isArray(d?.estimates) ? d.estimates : []).map((e: any) => ({ externalId: String(e.id), title: String(e.title || "Estimate"), amountCents: Math.round(Number(e.amountCents || 0)), status: String(e.status || "open"), createdAt: e.createdAt }));
  },
  async getMembership(ctx, externalCustomerId) {
    const d = await generic(ctx, "get_membership", { customerId: externalCustomerId });
    const m = d?.membership;
    return m?.id ? { externalId: String(m.id), name: String(m.name || "Membership"), status: String(m.status || "active"), expiresAt: m.expiresAt } : null;
  },
};

// ── Google Calendar ───────────────────────────────────────────────────────────

async function googleToken(ctx: ConnectorContext): Promise<string> {
  const cached = ctx.cache.get<string>("token");
  if (cached) return cached;
  const { clientId, clientSecret, refreshToken } = ctx.credentials;
  if (!clientId || !clientSecret || !refreshToken) throw new ConnectorError("Google Calendar needs an OAuth client id, client secret and refresh token.");
  const res = await ctx.http({
    method: "POST", url: "https://oauth2.googleapis.com/token", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
  });
  const data = expectOk(res, "Google sign-in");
  ctx.cache.set("token", data.access_token, Math.max(60, Number(data.expires_in || 3600) - 120));
  return data.access_token;
}

async function gcal(ctx: ConnectorContext, method: any, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  const res = await ctx.http({ method, url: "https://www.googleapis.com/calendar/v3" + path, headers: { authorization: `Bearer ${await googleToken(ctx)}` }, query: opts.query, body: opts.body });
  return expectOk(res, `Google Calendar ${method}`);
}

const calId = (ctx: ConnectorContext) => encodeURIComponent(ctx.settings.calendarId || "primary");

/** UNVERIFIED against a live Google account; uses freeBusy and events.insert as documented. */
export const googleCalendar: CrmConnector = {
  kind: "google_calendar",
  label: "Google Calendar",
  maturity: "unverified",
  credentialFields: [
    { key: "clientId", label: "OAuth client ID", required: true },
    { key: "clientSecret", label: "OAuth client secret", secret: true, required: true },
    { key: "refreshToken", label: "Refresh token", secret: true, required: true },
  ],
  settingFields: [{ key: "calendarId", label: "Calendar ID", help: "Leave empty for the primary calendar." }],

  async test(ctx) {
    await gcal(ctx, "GET", `/calendars/${calId(ctx)}`);
  },
  async lookupCustomer() { return null; },
  async getAvailability(ctx, query) {
    const id = ctx.settings.calendarId || "primary";
    const data = await gcal(ctx, "POST", "/freeBusy", { body: { timeMin: query.from.toISOString(), timeMax: query.to.toISOString(), timeZone: ctx.org.timezone, items: [{ id }] } });
    const busy = (data?.calendars?.[id]?.busy || []).map((b: any) => ({ start: new Date(b.start), end: new Date(b.end) }));
    return subtractBusy(candidateSlots(ctx.org, query.from, query.to), busy);
  },
  async bookJob(ctx, input) {
    const a = input.customer.address || {};
    const ev = await gcal(ctx, "POST", `/calendars/${calId(ctx)}/events`, {
      // Google does not email guests unless asked to.
      query: { sendUpdates: input.customer.email ? "all" : "none" },
      body: {
        summary: `${input.jobType} — ${input.customer.name || input.customer.phone}`,
        description: [input.notes, `Phone: ${input.customer.phone}`].filter(Boolean).join("\n"),
        location: [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(", ") || undefined,
        start: { dateTime: input.start.toISOString(), timeZone: ctx.org.timezone },
        end: { dateTime: input.end.toISOString(), timeZone: ctx.org.timezone },
        attendees: input.customer.email ? [{ email: input.customer.email }] : undefined,
        extendedProperties: { private: { pineIdempotencyKey: input.idempotencyKey.slice(0, 1000) } },
      },
    });
    return { externalJobId: String(ev.id), externalCustomerId: input.externalCustomerId || "" };
  },
  async reschedule(ctx, input) {
    await gcal(ctx, "PATCH", `/calendars/${calId(ctx)}/events/${encodeURIComponent(input.externalJobId)}`, {
      body: { start: { dateTime: input.start.toISOString(), timeZone: ctx.org.timezone }, end: { dateTime: input.end.toISOString(), timeZone: ctx.org.timezone } },
    });
  },
  async cancel(ctx, input) {
    await gcal(ctx, "DELETE", `/calendars/${calId(ctx)}/events/${encodeURIComponent(input.externalJobId)}`);
  },
  async createLead() { return { externalId: "" }; },
  async getEstimates() { return []; },
  async getMembership() { return null; },
};

// ── Outlook (Microsoft Graph) ─────────────────────────────────────────────────

async function graphToken(ctx: ConnectorContext): Promise<string> {
  const cached = ctx.cache.get<string>("token");
  if (cached) return cached;
  const { clientId, clientSecret } = ctx.credentials;
  const tenant = String(ctx.settings.tenantId || "");
  if (!clientId || !clientSecret || !/^[\w.-]+$/.test(tenant)) throw new ConnectorError("Outlook needs an app (client) id, a client secret and the Microsoft 365 tenant id.");
  const res = await ctx.http({
    method: "POST", url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default" }).toString(),
  });
  const data = expectOk(res, "Microsoft sign-in");
  ctx.cache.set("token", data.access_token, Math.max(60, Number(data.expires_in || 3600) - 120));
  return data.access_token;
}

async function graph(ctx: ConnectorContext, method: any, path: string, body?: any): Promise<any> {
  const mailbox = String(ctx.settings.mailbox || "");
  if (!/^[^@\s/]+@[^@\s/]+$/.test(mailbox)) throw new ConnectorError("Set the mailbox (email address) whose calendar is used.");
  const res = await ctx.http({
    method, url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}${path}`,
    headers: { authorization: `Bearer ${await graphToken(ctx)}`, prefer: `outlook.timezone="UTC"` }, body,
  });
  return expectOk(res, `Outlook ${method}`);
}

const graphTime = (d: Date) => ({ dateTime: d.toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" });

/**
 * UNVERIFIED against a live Microsoft 365 tenant. Uses getSchedule (findMeetingTimes needs a
 * signed-in user, which a backend does not have).
 */
export const outlook: CrmConnector = {
  kind: "outlook",
  label: "Outlook Calendar",
  maturity: "unverified",
  credentialFields: [
    { key: "clientId", label: "Application (client) ID", required: true },
    { key: "clientSecret", label: "Client secret", secret: true, required: true },
  ],
  settingFields: [
    { key: "tenantId", label: "Microsoft 365 tenant ID", required: true },
    { key: "mailbox", label: "Calendar mailbox", required: true, help: "The email address whose calendar holds the jobs." },
  ],
  accessNote: "An admin grants the app the Calendars.ReadWrite application permission.",

  async test(ctx) {
    await graph(ctx, "GET", "/calendar");
  },
  async lookupCustomer() { return null; },
  async getAvailability(ctx, query) {
    const data = await graph(ctx, "POST", "/calendar/getSchedule", {
      schedules: [ctx.settings.mailbox], startTime: graphTime(query.from), endTime: graphTime(query.to), availabilityViewInterval: 30,
    });
    const busy = (data?.value?.[0]?.scheduleItems || [])
      .filter((i: any) => i.status !== "free")
      .map((i: any) => ({ start: new Date(i.start.dateTime + "Z"), end: new Date(i.end.dateTime + "Z") }));
    return subtractBusy(candidateSlots(ctx.org, query.from, query.to), busy);
  },
  async bookJob(ctx, input) {
    const a = input.customer.address || {};
    const ev = await graph(ctx, "POST", "/events", {
      subject: `${input.jobType} — ${input.customer.name || input.customer.phone}`,
      body: { contentType: "text", content: [input.notes, `Phone: ${input.customer.phone}`].filter(Boolean).join("\n") },
      start: graphTime(input.start), end: graphTime(input.end),
      location: { displayName: [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(", ") },
      attendees: input.customer.email ? [{ emailAddress: { address: input.customer.email, name: input.customer.name }, type: "required" }] : [],
      transactionId: input.idempotencyKey.slice(0, 120),
    });
    return { externalJobId: String(ev.id), externalCustomerId: input.externalCustomerId || "" };
  },
  async reschedule(ctx, input) {
    await graph(ctx, "PATCH", `/events/${encodeURIComponent(input.externalJobId)}`, { start: graphTime(input.start), end: graphTime(input.end) });
  },
  async cancel(ctx, input) {
    await graph(ctx, "POST", `/events/${encodeURIComponent(input.externalJobId)}/cancel`, { comment: input.reason || "Cancelled by phone" });
  },
  async createLead() { return { externalId: "" }; },
  async getEstimates() { return []; },
  async getMembership() { return null; },
};
