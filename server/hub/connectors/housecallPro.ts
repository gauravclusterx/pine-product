/**
 * Housecall Pro — public REST API, API key from the client's account (MAX plan only).
 *
 * UNVERIFIED: written from Housecall Pro's published API reference; not yet run against a real
 * account.
 */
import { ConnectorContext, ConnectorError, CrmConnector, expectOk, national10, splitName } from "../types.js";

const BASE = "https://api.housecallpro.com";

async function call(ctx: ConnectorContext, method: any, path: string, opts: { query?: any; body?: any } = {}): Promise<any> {
  if (!ctx.credentials.apiKey) throw new ConnectorError("Housecall Pro API key is required.");
  const res = await ctx.http({ method, url: BASE + path, headers: { authorization: `Token ${ctx.credentials.apiKey}`, accept: "application/json" }, query: opts.query, body: opts.body });
  return expectOk(res, `Housecall Pro ${method} ${path}`);
}

export const housecallPro: CrmConnector = {
  kind: "housecall_pro",
  label: "Housecall Pro",
  maturity: "unverified",
  credentialFields: [{ key: "apiKey", label: "API key", secret: true, required: true, help: "App Store → API Key Management in the client's Housecall Pro account." }],
  accessNote: "The client must be on the Housecall Pro MAX plan — the API and webhooks are not available on other plans.",

  async test(ctx) {
    await call(ctx, "GET", "/company");
  },

  async lookupCustomer(ctx, phone) {
    const data = await call(ctx, "GET", "/customers", { query: { q: national10(phone), page_size: 5 } });
    const want = national10(phone);
    const c = (data?.customers || []).find((x: any) => [x.mobile_number, x.home_number, x.work_number].some((n: any) => national10(String(n || "")) === want));
    if (!c) return null;
    const a = c.addresses?.[0] || {};
    return {
      externalId: String(c.id), name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "", phone, email: c.email || undefined,
      address: { street: a.street, city: a.city, state: a.state, postalCode: a.zip }, notes: c.notes || undefined,
    };
  },

  async getAvailability(ctx, query) {
    const data = await call(ctx, "GET", "/company/schedule_availability/booking_windows", {
      query: { start_date: query.from.toISOString().slice(0, 10), show_for_days: Math.max(1, Math.ceil((query.to.getTime() - query.from.getTime()) / 86_400_000)) },
    });
    return (data?.booking_windows || [])
      .filter((w: any) => w.available !== false)
      .map((w: any) => ({ start: new Date(w.start_time), end: new Date(w.end_time) }))
      .filter((s: any) => !Number.isNaN(s.start.getTime()) && s.start >= query.from && s.end <= query.to);
  },

  async bookJob(ctx, input) {
    let customerId = input.externalCustomerId || "";
    let addressId = "";
    const a = input.customer.address || {};
    if (!customerId) {
      const n = splitName(input.customer.name);
      const created = await call(ctx, "POST", "/customers", {
        body: {
          first_name: n.first || "New", last_name: n.last || "Customer", mobile_number: national10(input.customer.phone), email: input.customer.email || undefined,
          notifications_enabled: true, lead_source: input.source || "Pine AI",
          addresses: a.street ? [{ street: a.street, city: a.city || "", state: a.state || "", zip: a.postalCode || "", country: "US" }] : [],
        },
      });
      customerId = String(created.id);
      addressId = String(created.addresses?.[0]?.id || "");
    } else {
      const c = await call(ctx, "GET", `/customers/${encodeURIComponent(customerId)}`);
      addressId = String(c.addresses?.[0]?.id || "");
    }
    if (!addressId) {
      if (!a.street) throw new ConnectorError("A service address is needed to book in Housecall Pro.");
      const addr = await call(ctx, "POST", `/customers/${encodeURIComponent(customerId)}/addresses`, { body: { street: a.street, city: a.city || "", state: a.state || "", zip: a.postalCode || "", country: "US" } });
      addressId = String(addr.id);
    }
    const job = await call(ctx, "POST", "/jobs", {
      body: {
        customer_id: customerId, address_id: addressId, notes: input.notes || "", lead_source: input.source || "Pine AI",
        schedule: { scheduled_start: input.start.toISOString(), scheduled_end: input.end.toISOString(), arrival_window: Math.round((input.end.getTime() - input.start.getTime()) / 60_000) },
        line_items: [{ name: input.jobType, quantity: 1 }],
      },
    });
    return { externalJobId: String(job.id), externalCustomerId: customerId };
  },

  async reschedule(ctx, input) {
    await call(ctx, "PUT", `/jobs/${encodeURIComponent(input.externalJobId)}/schedule`, {
      body: { start_time: input.start.toISOString(), end_time: input.end.toISOString(), arrival_window_in_minutes: Math.round((input.end.getTime() - input.start.getTime()) / 60_000), notify: true },
    });
  },

  async cancel(ctx, input) {
    await call(ctx, "DELETE", `/jobs/${encodeURIComponent(input.externalJobId)}/schedule`);
  },

  async createLead(ctx, input) {
    const n = splitName(input.customer.name);
    const lead = await call(ctx, "POST", "/leads", {
      body: {
        customer: { first_name: n.first || "New", last_name: n.last || "Lead", mobile_number: national10(input.customer.phone), email: input.customer.email || undefined },
        lead_source: input.source || "Pine AI", note: input.summary.slice(0, 2000),
      },
    });
    return { externalId: String(lead.id) };
  },

  async getEstimates(ctx, externalCustomerId) {
    const data = await call(ctx, "GET", "/estimates", { query: { customer_id: externalCustomerId, page_size: 10 } });
    return (data?.estimates || [])
      .filter((e: any) => !/won|lost|expired|cancel/i.test(String(e.work_status || "")))
      .map((e: any) => ({
        externalId: String(e.id), title: e.options?.[0]?.name || `Estimate ${e.estimate_number || ""}`.trim(),
        amountCents: Number(e.options?.[0]?.total_amount ?? 0), status: e.work_status || "open", createdAt: e.created_at,
      }));
  },

  async getMembership() {
    // Housecall Pro does not expose service plans through its public API.
    return null;
  },
};
