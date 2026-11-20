import { beforeEach, describe, expect, it } from "vitest";
import { makeOrg, resetDb } from "../../tests/helpers.js";
import { q } from "../db/pool.js";
import { getOrg, updateOrg } from "../modules/orgs.js";
import { buildCustomerMemory, findCustomerByPhone, upsertCustomer } from "../modules/customers.js";
import { normaliseSpokenNumbers, timeOf } from "../lib/spoken.js";
import { resolveRequestedStart, runTool } from "./service.js";
import { resolveDayRange } from "./slots.js";
import { saveIntegration } from "./registry.js";
import { clearCache } from "./http.js";
import type { HttpFn, HttpRequest } from "./types.js";

// Fri 20 Nov 2026, 10:00 in New York.
const NOW = new Date("2026-11-20T15:00:00Z");
const PHONE = "+12125550142";

beforeEach(async () => { await resetDb(); clearCache(); });

async function org(settings: Record<string, any> = {}) {
  const o = await makeOrg({ timezone: "America/New_York" });
  await updateOrg(o.id, { settings: { slotMinutes: 120, slotCapacity: 1, services: [{ name: "AC repair", durationMinutes: 120, valueCents: 35000 }], ...settings } });
  return getOrg(o.id);
}

/** A fake HTTP layer that records requests and answers from a routing function. */
function fakeHttp(route: (r: HttpRequest) => { status: number; data: any } | undefined) {
  const calls: HttpRequest[] = [];
  const http: HttpFn = async (r) => {
    calls.push(r);
    const out = route(r) || { status: 404, data: { message: "no route " + r.url } };
    return { ...out, headers: {} };
  };
  return { http, calls };
}

describe("spoken times", () => {
  it("normalises the phrases speech-to-text produces", () => {
    expect(normaliseSpokenNumbers("twenty-first of November, five PM")).toBe("21st november, 5 pm");
    expect(timeOf("21st november 5 pm")).toEqual({ hour: 17, minute: 0 });
    expect(timeOf("saturday at 5")).toEqual({ hour: 17, minute: 0 });
    expect(timeOf("saturday")).toBeNull();
  });
  it("resolves days in the client's zone", async () => {
    const o = await org();
    const sat = resolveDayRange("Saturday", o.timezone, NOW)!;
    expect(sat.from.toISOString()).toBe("2026-11-21T05:00:00.000Z");
    expect(resolveDayRange("twenty first of november", o.timezone, NOW)!.from.toISOString()).toBe("2026-11-21T05:00:00.000Z");
    expect(resolveDayRange("31st february", o.timezone, NOW)).toBeNull();
    // A date that has passed this year means next year.
    expect(resolveDayRange("3rd january", o.timezone, NOW)!.from.toISOString().slice(0, 10)).toBe("2027-01-03");
  });
  it("turns an agreed time into an instant, and refuses a day with no time", async () => {
    const o = await org();
    expect(resolveRequestedStart(o, "Saturday at five PM", NOW)!.toISOString()).toBe("2026-11-21T22:00:00.000Z");
    expect(resolveRequestedStart(o, "2026-11-23T14:00:00.000Z", NOW)!.toISOString()).toBe("2026-11-23T14:00:00.000Z");
    expect(resolveRequestedStart(o, "Saturday", NOW)).toBeNull();
  });
});

describe("availability and booking on the built-in calendar", () => {
  it("offers windows inside business hours only, in the client's zone", async () => {
    const o = await org();
    const r = await runTool(o, "get_availability", { day: "Monday", job_type: "AC repair" }, {}, { now: NOW });
    const slots = r.data!.slots as Array<{ start: string; label: string }>;
    // Mon 23 Nov, 8:00–17:00 local, 2-hour windows: 8, 10, 12, 14 (16:00 would end at 18:00).
    expect(slots.map((s) => s.start)).toEqual(["2026-11-23T13:00:00.000Z", "2026-11-23T15:00:00.000Z", "2026-11-23T17:00:00.000Z", "2026-11-23T19:00:00.000Z"]);
    expect(slots[0].label).toMatch(/Mon, Nov 23 at 8:00 AM – 10:00 AM/);
  });

  it("a closed day points to the nearest open days", async () => {
    const o = await org();
    const r = await runTool(o, "get_availability", { day: "Sunday" }, {}, { now: NOW });
    expect(r.result).toMatch(/Nothing is open that day/);
    expect((r.data!.slots as any[]).length).toBeGreaterThan(0);
  });

  it("books an offered window, saves the customer, and the window is gone afterwards", async () => {
    const o = await org();
    const r = await runTool(o, "book_job", { start: "2026-11-23T15:00:00.000Z", job_type: "AC repair", customer_phone: PHONE, customer_name: "Jordan Price" }, { providerCallId: "call_1" }, { now: NOW });
    expect(r.result).toMatch(/^Booked: AC repair, Mon, Nov 23 at 10:00 AM/);
    const b = (await q("SELECT * FROM bookings"))[0];
    expect(b).toMatchObject({ connector: "native", job_type: "AC repair", value_cents: 35000, status: "booked" });
    expect((await findCustomerByPhone(o.id, PHONE))!.name).toBe("Jordan Price");
    const again = await runTool(o, "get_availability", { day: "Monday" }, {}, { now: NOW });
    expect((again.data!.slots as any[]).map((s) => s.start)).not.toContain("2026-11-23T15:00:00.000Z");
  });

  it("books from spoken words too", async () => {
    const o = await org();
    const r = await runTool(o, "book_job", { start: "Monday at ten AM", customer_phone: PHONE }, { providerCallId: "c" }, { now: NOW });
    expect(r.result).toMatch(/^Booked: .*Mon, Nov 23 at 10:00 AM/);
  });

  it("a retried tool call books once", async () => {
    const o = await org();
    const args = { start: "2026-11-23T15:00:00.000Z", customer_phone: PHONE };
    await runTool(o, "book_job", args, { providerCallId: "call_x" }, { now: NOW });
    const second = await runTool(o, "book_job", args, { providerCallId: "call_x" }, { now: NOW });
    expect(second.result).toMatch(/Already booked/);
    expect((await q("SELECT count(*)::int AS n FROM bookings"))[0].n).toBe(1);
  });

  it("two callers racing for the last place: exactly one gets it", async () => {
    const o = await org();
    const start = "2026-11-23T15:00:00.000Z";
    const results = await Promise.all([
      runTool(o, "book_job", { start, customer_phone: "+12125550101" }, { providerCallId: "a" }, { now: NOW }),
      runTool(o, "book_job", { start, customer_phone: "+12125550102" }, { providerCallId: "b" }, { now: NOW }),
      runTool(o, "book_job", { start, customer_phone: "+12125550103" }, { providerCallId: "c" }, { now: NOW }),
    ]);
    expect(results.filter((r) => r.result.startsWith("Booked")).length).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM bookings"))[0].n).toBe(1);
  });

  it("refuses a time outside the offered windows and says what is open", async () => {
    const o = await org();
    const r = await runTool(o, "book_job", { start: "Monday at 7 PM", customer_phone: PHONE }, {}, { now: NOW });
    expect(r.result).toMatch(/is not available/);
    expect(r.data!.booked).toBe(false);
  });

  it("a day with no time is not booked at a default hour", async () => {
    const o = await org();
    const r = await runTool(o, "book_job", { start: "Saturday", customer_phone: PHONE }, {}, { now: NOW });
    expect(r.result).toMatch(/could not be read/);
    expect((await q("SELECT count(*)::int AS n FROM bookings"))[0].n).toBe(0);
  });

  it("refuses an area the business does not serve", async () => {
    const o = await org({ serviceAreas: ["10001", "112*"] });
    expect((await runTool(o, "get_availability", { postal_code: "90210" }, {}, { now: NOW })).result).toMatch(/do not serve/);
    expect((await runTool(o, "get_availability", { postal_code: "11215" }, {}, { now: NOW })).data!.slots).toBeDefined();
  });

  it("reschedules and cancels the customer's next appointment", async () => {
    const o = await org();
    await runTool(o, "book_job", { start: "2026-11-23T15:00:00.000Z", customer_phone: PHONE }, { providerCallId: "r" }, { now: NOW });
    const moved = await runTool(o, "reschedule_job", { start: "2026-11-24T17:00:00.000Z", customer_phone: PHONE }, {}, { now: NOW });
    expect(moved.result).toMatch(/^Moved to Tue, Nov 24 at 12:00 PM/);
    const cancelled = await runTool(o, "cancel_job", { customer_phone: PHONE }, {}, { now: NOW });
    expect(cancelled.result).toMatch(/^Cancelled/);
    expect((await q("SELECT status FROM bookings"))[0].status).toBe("cancelled");
  });
});

describe("per-customer memory", () => {
  it("a known caller's name, history and upcoming job reach the agent", async () => {
    const o = await org();
    const c = await upsertCustomer(o.id, { phone: PHONE, name: "Tarun", notes: "Gate code 4411" });
    await q("INSERT INTO calls (org_id, provider_call_id, customer_id, direction, summary, outcome, started_at) VALUES ($1, 'p1', $2, 'inbound', 'Asked about a noisy outdoor unit; wants a quote.', 'quote', now() - interval '2 days')", [o.id, c.id]);
    await runTool(o, "book_job", { start: "2026-11-23T15:00:00.000Z", customer_phone: PHONE }, { providerCallId: "m" }, { now: NOW });
    const look = await runTool(o, "lookup_customer", { phone: PHONE }, { providerAgentId: "agent_1" }, { now: NOW });
    expect(look.data).toMatchObject({ known: true, name: "Tarun" });
    expect(look.data!.profile).toMatch(/Name on file: Tarun/);
    expect(look.data!.profile).toMatch(/Gate code 4411/);
    expect(look.data!.context).toMatch(/noisy outdoor unit/);
    expect(look.data!.context).toMatch(/Upcoming job/);
  });

  it("the name on file is never replaced by what a caller or a form says", async () => {
    const o = await org();
    await upsertCustomer(o.id, { phone: PHONE, name: "Tarun" });
    await upsertCustomer(o.id, { phone: PHONE, name: "Vinayak" });
    expect((await findCustomerByPhone(o.id, PHONE))!.name).toBe("Tarun");
  });

  it("an unknown caller is flagged as new", async () => {
    const o = await org();
    const m = await buildCustomerMemory(o, null, NOW);
    expect(m.context).toMatch(/not in the system yet/);
  });

  it("an inbound caller is remembered for the during-call tools of the same agent", async () => {
    const o = await org();
    await runTool(o, "lookup_customer", { phone: PHONE }, { providerAgentId: "agent_1" }, { now: NOW });
    const r = await runTool(o, "book_job", { start: "2026-11-23T15:00:00.000Z" }, { providerAgentId: "agent_1" }, { now: NOW });
    expect(r.result).toMatch(/^Booked/);
    // A second simultaneous caller makes it ambiguous: the tool then asks instead of guessing.
    await runTool(o, "lookup_customer", { phone: "+12125550199" }, { providerAgentId: "agent_1" }, { now: NOW });
    const r2 = await runTool(o, "book_job", { start: "2026-11-23T17:00:00.000Z" }, { providerAgentId: "agent_1" }, { now: NOW });
    expect(r2.result).toMatch(/phone number/);
  });
});

describe("connectors through the hub", () => {
  it("custom REST: lookup fills memory, booking goes to the client's system", async () => {
    const o = await org({ crm: "generic_rest" });
    await saveIntegration(o.id, "generic_rest", { credentials: { apiKey: "k-123" }, settings: { endpointUrl: "https://client.example/pine" } });
    const fake = fakeHttp((r) => {
      const b: any = r.body;
      if (r.headers?.["x-api-key"] !== "k-123") return { status: 401, data: { message: "bad key" } };
      if (b.action === "lookup_customer") return { status: 200, data: { customer: { id: "C-9", name: "Maria Santos", address: { postalCode: "10001" } } } };
      if (b.action === "get_availability") return { status: 200, data: { slots: [{ start: "2026-11-23T14:00:00Z", end: "2026-11-23T16:00:00Z" }] } };
      if (b.action === "book_job") return { status: 200, data: { jobId: "J-77", customerId: "C-9" } };
      return undefined;
    });
    const look = await runTool(o, "lookup_customer", { phone: PHONE }, {}, { now: NOW, http: fake.http });
    expect(look.data!.name).toBe("Maria Santos");
    const avail = await runTool(o, "get_availability", { day: "Monday" }, {}, { now: NOW, http: fake.http });
    expect((avail.data!.slots as any[])[0].start).toBe("2026-11-23T14:00:00.000Z");
    const booked = await runTool(o, "book_job", { start: "2026-11-23T14:00:00.000Z", customer_phone: PHONE }, { providerCallId: "g1" }, { now: NOW, http: fake.http });
    expect(booked.result).toMatch(/^Booked/);
    const sent = fake.calls.find((c) => (c.body as any)?.action === "book_job")!.body as any;
    expect(sent).toMatchObject({ customerId: "C-9", start: "2026-11-23T14:00:00.000Z", idempotencyKey: "g1:2026-11-23T14:00:00.000Z" });
    expect((await q("SELECT external_job_id FROM bookings"))[0].external_job_id).toBe("J-77");
  });

  it("ServiceTitan: token is fetched once and reused; capacity drives availability", async () => {
    const o = await org({ crm: "servicetitan" });
    await saveIntegration(o.id, "servicetitan", {
      credentials: { clientId: "cid", clientSecret: "sec", appKey: "ak" },
      settings: { tenantId: "555", businessUnitId: "1", defaultJobTypeId: "9", campaignId: "3" },
    });
    let tokens = 0;
    const fake = fakeHttp((r) => {
      if (r.url.endsWith("/connect/token")) { tokens++; return { status: 200, data: { access_token: "tok", expires_in: 900 } }; }
      if (r.url.includes("/dispatch/v2/tenant/555/capacity")) {
        return { status: 200, data: { availabilities: [
          { startUtc: "2026-11-23T14:00:00Z", endUtc: "2026-11-23T16:00:00Z", isAvailable: true },
          { startUtc: "2026-11-23T16:00:00Z", endUtc: "2026-11-23T18:00:00Z", isAvailable: false },
        ] } };
      }
      return undefined;
    });
    const a = await runTool(o, "get_availability", { day: "Monday" }, {}, { now: NOW, http: fake.http });
    await runTool(o, "get_availability", { day: "Monday" }, {}, { now: NOW, http: fake.http });
    expect((a.data!.slots as any[]).map((s) => s.start)).toEqual(["2026-11-23T14:00:00.000Z"]);
    expect(tokens).toBe(1);
    const capReq = fake.calls.find((c) => c.url.includes("/capacity"))!;
    expect(capReq.headers).toMatchObject({ authorization: "Bearer tok", "ST-App-Key": "ak" });
  });

  it("a failing schedule system makes the agent hold back, not promise", async () => {
    const o = await org({ crm: "housecall_pro" });
    await saveIntegration(o.id, "housecall_pro", { credentials: { apiKey: "x" }, settings: {} });
    const fake = fakeHttp(() => ({ status: 503, data: { message: "maintenance" } }));
    const r = await runTool(o, "get_availability", { day: "Monday" }, {}, { now: NOW, http: fake.http });
    expect(r.result).toMatch(/did not answer properly/);
    expect((await q("SELECT status, last_error FROM integrations"))[0]).toMatchObject({ status: "error" });
  });

  it("Jobber persists a rotated refresh token", async () => {
    const o = await org({ crm: "jobber" });
    await saveIntegration(o.id, "jobber", { credentials: { clientId: "c", clientSecret: "s", refreshToken: "r1" }, settings: {} });
    const fake = fakeHttp((r) => {
      if (r.url.endsWith("/oauth/token")) return { status: 200, data: { access_token: "a", refresh_token: "r2" } };
      if (r.url.endsWith("/graphql")) return { status: 200, data: { data: { clients: { nodes: [{ id: "J1", name: "Sam Lee", phones: [{ number: "(212) 555-0142" }] }] } } } };
      return undefined;
    });
    const look = await runTool(o, "lookup_customer", { phone: PHONE }, {}, { now: NOW, http: fake.http });
    expect(look.data!.name).toBe("Sam Lee");
    const { getIntegration } = await import("./registry.js");
    expect((await getIntegration(o.id, "jobber"))!.credentials.refreshToken).toBe("r2");
  });
});

describe("messages", () => {
  it("SMS is not sent to an opted-out number, and a STOP reply opts the number out", async () => {
    const o = await org();
    await saveIntegration(o.id, "twilio", { credentials: { accountSid: "AC1", authToken: "t" }, settings: { messagingServiceSid: "MG1" } });
    const fake = fakeHttp(() => ({ status: 400, data: { code: 21610, message: "unsubscribed" } }));
    const first = await runTool(o, "send_sms", { customer_phone: PHONE, message: "hi" }, {}, { http: fake.http });
    expect(first.result).toMatch(/could not be sent/);
    expect((await q("SELECT reason, source FROM dnc_list"))[0]).toMatchObject({ reason: "opt_out", source: "sms_stop" });
    const second = await runTool(o, "send_sms", { customer_phone: PHONE, message: "hi" }, {}, { http: fake.http });
    expect(second.result).toMatch(/opted out/);
    expect(fake.calls).toHaveLength(1);
  });

  it("team alerts go to Slack and are kept in the feed", async () => {
    const o = await org();
    await saveIntegration(o.id, "slack", { credentials: { webhookUrl: "https://hooks.slack.com/services/T/B/X" }, settings: {} });
    const fake = fakeHttp((r) => (r.url.startsWith("https://hooks.slack.com") ? { status: 200, data: "ok" } : undefined));
    const r = await runTool(o, "notify_team", { kind: "emergency", message: "Gas smell reported", customer_phone: PHONE }, {}, { http: fake.http });
    expect(r.result).toMatch(/team has been told/);
    expect((fake.calls[0].body as any).text).toMatch(/🚨 Gas smell reported — caller \+12125550142/);
    expect((await q("SELECT action FROM audit_log WHERE action = 'team.alert'")).length).toBe(1);
  });
});
