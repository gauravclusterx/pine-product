/**
 * End-to-end through HTTP: the real app, the real database, the voice provider replaced by a
 * fake (no network). Covers sign-in, tenant isolation, the signed call webhook, billing, the
 * agent tools, lead intake → speed-to-lead call, opt-outs and call scoring.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { resetDb } from "./helpers.js";
import { q, one } from "../server/db/pool.js";
import { hashPassword } from "../server/auth/auth.js";
import { signWebhook } from "../server/voice/rasen/webhook.js";
import { createWorker } from "../server/queue/queue.js";
import { handlers } from "../server/jobs.js";

const calls: any[] = [];
vi.mock("../server/voice/rasen/service.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    inspectRasenApiKey: vi.fn(async (key: string) => key.startsWith("ra_ok")
      ? { valid: true, missingCapabilities: [], reason: null, context: { workspace_id: key === "ra_ok_b_0123456789" ? "ws_b" : "ws_a" } }
      : { valid: false, missingCapabilities: [], reason: "invalid key", context: null }),
    ensureWebhookEndpoint: vi.fn(async () => ({ id: "we_1", created: true, secret: process.env.RASEN_WEBHOOK_SECRET, events: [], state: "active" })),
    createAgent: vi.fn(async () => ({ id: `agent_${Math.random().toString(36).slice(2, 10)}`, name: "x", state: "draft", liveVersionId: null, publishError: null })),
    updateAgentConfig: vi.fn(async () => ({ liveVersionId: null })),
    syncAgentTools: vi.fn(async () => ({ created: [], replaced: [], removed: [] })),
    publishAgent: vi.fn(async () => ({ liveVersionId: "pub_1", created: true })),
    getCallUsageSeconds: vi.fn(async () => 95),
    createOutboundCall: vi.fn(async (_ws: any, args: any) => { calls.push(args); return { id: `call_out_${calls.length}`, status: "queued", state: "admitted" }; }),
    suppressDestination: vi.fn(async () => {}),
  };
});

const { buildApp } = await import("../server/app.js");
const app = buildApp();
const SECRET = () => process.env.RASEN_WEBHOOK_SECRET!;

async function signedIn(email: string, password = "Password123") {
  const agent = request.agent(app);
  const r = await agent.post("/api/auth/login").send({ email, password });
  expect(r.status).toBe(200);
  return { agent, csrf: { "x-pine-csrf": "1" } };
}

let admin: Awaited<ReturnType<typeof signedIn>>;

async function setupOrg(name: string, key: string) {
  const r = await admin.agent.post("/api/admin/orgs").set(admin.csrf).send({ name, industry: "hvac", timezone: "America/New_York", ownerEmail: `${name.split(" ")[0].toLowerCase()}@example.com`, rateCentsPerMinute: 30 });
  expect(r.status).toBe(201);
  const orgId = r.body.org.id;
  const v = await admin.agent.put(`/api/admin/orgs/${orgId}/voice-key`).set(admin.csrf).send({ apiKey: key });
  expect(v.status).toBe(200);
  await q("UPDATE users SET password_hash = $2 WHERE email = $1", [r.body.owner.email || `${name.split(" ")[0].toLowerCase()}@example.com`, await hashPassword("Password123")]);
  const owner = await signedIn(`${name.split(" ")[0].toLowerCase()}@example.com`);
  return { orgId, owner };
}

function webhook(evt: any, opts: { secret?: string; id?: string; ts?: number } = {}) {
  const body = JSON.stringify(evt);
  const id = opts.id || evt.id;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return request(app).post("/api/webhooks/voice").set("content-type", "application/json")
    .set("webhook-id", id).set("webhook-timestamp", ts).set("webhook-signature", signWebhook(opts.secret || SECRET(), id, ts, body)).send(body);
}

function analyzed(callId: string, providerAgentId: string, opts: { to?: string; outcome?: string; turns?: any[]; optedOut?: boolean; metadata?: any; direction?: string } = {}) {
  return {
    id: `evt_${callId}_${Math.random().toString(36).slice(2, 6)}`, type: "call.analyzed", created_at: new Date().toISOString(), workspace_id: "ws_a", api_version: "v1",
    data: {
      call: {
        id: callId, agent_id: providerAgentId, direction: opts.direction || "outbound", state: "completed", terminal: true, end_reason: "customer_hangup", dial_outcome: "answered",
        created_at: new Date(Date.now() - 120_000).toISOString(), ended_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        transcript_state: "ready", summary_state: "ready", extraction_state: "ready", metadata: { to_number: opts.to || "+12125550142", ...(opts.metadata || {}) },
      },
      transcript: { turns: opts.turns || [
        { index: 0, speaker: "agent", text: "Thanks for calling Acme Heating, this is Ava. How can I help?", start_ms: 0, end_ms: 3000 },
        { index: 1, speaker: "customer", text: "My AC is not cooling, can you send someone tomorrow?", start_ms: 3500, end_ms: 7000 },
        { index: 2, speaker: "agent", text: "I can book tomorrow at 10 AM. Does that work?", start_ms: 7500, end_ms: 10_000 },
        { index: 3, speaker: "customer", text: "Yes please, thanks.", start_ms: 10_500, end_ms: 12_000 },
        { index: 4, speaker: "agent", text: "You're booked. Thank you, have a great day!", start_ms: 12_500, end_ms: 95_000 },
      ] },
      summary: { state: "ready", summary: "Customer's AC is not cooling; booked for tomorrow 10 AM." },
      extraction: { state: "ready", fields: [{ name: "outcome", value: opts.outcome || "booked" }, { name: "sentiment", value: "positive" }, ...(opts.optedOut ? [{ name: "opted_out", value: true }] : [])] },
      recording: { available: true },
    },
  };
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  await q("INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ('staff@pine.test', 'Staff', $1, true)", [await hashPassword("Password123")]);
  admin = await signedIn("staff@pine.test");
});

describe("sign-in and sessions", () => {
  it("rejects a wrong password with the same answer as an unknown email", async () => {
    const a = await request(app).post("/api/auth/login").send({ email: "staff@pine.test", password: "nope" });
    const b = await request(app).post("/api/auth/login").send({ email: "ghost@pine.test", password: "nope" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });
  it("needs a session, and the CSRF header on writes", async () => {
    expect((await request(app).get("/api/org")).status).toBe(401);
    const { orgId } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const r = await admin.agent.patch("/api/org").set("x-org-id", orgId).send({ name: "Acme 2" });
    expect(r.status).toBe(403);
  });
  it("a password change signs out every other session", async () => {
    const other = await signedIn("staff@pine.test");
    const r = await admin.agent.post("/api/auth/password").set(admin.csrf).send({ current: "Password123", next: "NewPassword456" });
    expect(r.status).toBe(200);
    expect((await other.agent.get("/api/auth/me")).status).toBe(401);
    expect((await admin.agent.get("/api/auth/me")).status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("an org's user cannot reach another org's data, even by naming it", async () => {
    const a = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const b = await setupOrg("Bolt Plumbing", "ra_ok_b_0123456789");
    const cust = await one("INSERT INTO customers (org_id, phone_e164, name) VALUES ($1, '+12125550199', 'Secret') RETURNING id", [b.orgId]);
    expect((await a.owner.agent.get(`/api/customers/${cust!.id}`)).status).toBe(404);
    expect((await a.owner.agent.get("/api/customers").set("x-org-id", b.orgId)).status).toBe(403);
    expect((await b.owner.agent.get(`/api/customers/${cust!.id}`)).status).toBe(200);
  });
  it("one voice workspace cannot be connected to two clients", async () => {
    await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const r = await admin.agent.post("/api/admin/orgs").set(admin.csrf).send({ name: "Copy Cat", ownerEmail: "cc@example.com" });
    const v = await admin.agent.put(`/api/admin/orgs/${r.body.org.id}/voice-key`).set(admin.csrf).send({ apiKey: "ra_ok_a_0123456789" });
    expect(v.status).toBe(409);
  });
});

async function liveAgent(owner: any, orgId: string, playbook = "inbound_booking") {
  const c = await owner.agent.post("/api/agents").set(owner.csrf).send({ name: "Ava", playbook });
  expect(c.status).toBe(201);
  const p = await owner.agent.post(`/api/agents/${c.body.agent.id}/publish`).set(owner.csrf);
  expect(p.status).toBe(200);
  expect(p.body.agent.status).toBe("live");
  return p.body.agent;
}

describe("call events", () => {
  it("a signed call.analyzed creates the call, bills it once, and scores it", async () => {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId);
    const evt = analyzed("call_1", agent.providerAgentId);
    expect((await webhook(evt)).status).toBe(200);
    const c = await one("SELECT * FROM calls WHERE provider_call_id = 'call_1'");
    expect(c).toMatchObject({ org_id: orgId, status: "ended", outcome: "booked", recording_available: true, phone_e164: "+12125550142" });
    expect(c!.billable_seconds).toBe(95);
    expect(c!.charge_cents).toBe(60); // 95 s → 2 minutes × 30¢
    // A replay is ignored; a re-delivery under a new id does not bill again.
    expect((await webhook(evt)).body.duplicate).toBe(true);
    await webhook({ ...evt, id: "evt_other" });
    expect((await one("SELECT count(*)::int AS n, sum(charge_cents)::int AS s FROM calls"))).toMatchObject({ n: 1, s: 60 });
    await createWorker({ handlers }).drain();
    const scored = await one("SELECT qa_score, qa FROM calls WHERE provider_call_id = 'call_1'");
    expect(scored!.qa_score).toBeGreaterThanOrEqual(80);
  });

  it("rejects forged, stale and wrong-secret events", async () => {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId);
    const evt = analyzed("call_2", agent.providerAgentId);
    expect((await webhook(evt, { secret: "whsec_" + Buffer.alloc(32, 9).toString("base64") })).status).toBe(401);
    expect((await webhook(evt, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await request(app).post("/api/webhooks/voice").send(evt)).status).toBe(401);
    expect(await one("SELECT 1 AS x FROM calls")).toBeNull();
  });

  it("an opt-out on a call puts the number on the do-not-call list", async () => {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId);
    await webhook(analyzed("call_3", agent.providerAgentId, { outcome: "not_interested", optedOut: true, to: "+12125550177" }));
    expect(await one("SELECT reason, source FROM dnc_list WHERE phone_e164 = '+12125550177'")).toMatchObject({ reason: "opt_out", source: "call" });
    const r = await owner.agent.post("/api/calls").set(owner.csrf).send({ agentId: agent.id, phone: "+12125550177" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/do-not-call/);
  });

  it("an inbound caller is matched to the call through the before-call lookup", async () => {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId);
    const ws = await one("SELECT tool_secret_enc FROM voice_workspaces WHERE org_id = $1", [orgId]);
    const { decrypt } = await import("../server/lib/crypto.js");
    const secret = decrypt(ws!.tool_secret_enc);
    await request(app).post(`/api/tools/${orgId}/lookup_customer`).set("x-pine-tool-secret", secret).send({ phone: "+12125550160", agent_id: agent.providerAgentId });
    const evt = analyzed("call_in", agent.providerAgentId, { direction: "inbound", to: "" });
    evt.data.call.metadata = {};
    await webhook(evt);
    expect((await one("SELECT phone_e164, direction FROM calls WHERE provider_call_id = 'call_in'"))).toMatchObject({ phone_e164: "+12125550160", direction: "inbound" });
  });
});

describe("agent tools over HTTP", () => {
  it("fail closed without the org's secret, and with another org's agent", async () => {
    const a = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const b = await setupOrg("Bolt Plumbing", "ra_ok_b_0123456789");
    const agentB = await liveAgent(b.owner, b.orgId);
    expect((await request(app).post(`/api/tools/${a.orgId}/get_availability`).send({})).status).toBe(401);
    const { decrypt } = await import("../server/lib/crypto.js");
    const secretA = decrypt((await one("SELECT tool_secret_enc FROM voice_workspaces WHERE org_id = $1", [a.orgId]))!.tool_secret_enc);
    expect((await request(app).post(`/api/tools/${a.orgId}/get_availability`).set("x-pine-tool-secret", "x" + secretA).send({})).status).toBe(401);
    expect((await request(app).post(`/api/tools/${a.orgId}/get_availability`).set("x-pine-tool-secret", secretA).send({ agent_id: agentB.providerAgentId })).status).toBe(403);
    const ok = await request(app).post(`/api/tools/${a.orgId}/get_availability`).set("x-pine-tool-secret", secretA).send({ day: "tomorrow" });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.result).toBe("string");
  });
});

describe("lead intake → speed to lead", () => {
  async function angiSetup() {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId, "speed_to_lead");
    await owner.agent.patch("/api/org").set(owner.csrf).send({ settings: { speedToLead: { enabled: true, agentId: agent.id }, serviceAreas: ["100*"], callingWindow: { opens: 480, closes: 1260 } } });
    const s = await owner.agent.put("/api/integrations/angi").set(owner.csrf).send({ credentials: {}, settings: {} });
    expect(s.body.inboundKey).toBeTruthy();
    return { orgId, owner, agent, key: s.body.inboundKey as string };
  }
  const angiLead = (id: string, extra: any = {}) => ({ leadOid: id, firstName: "Maria", lastName: "Santos", primaryPhone: "(212) 555-0142", taskName: "AC Repair", postalCode: "10001", comments: "AC blowing warm air", ...extra });

  it("an Angi lead is saved once and called with its details and memory", async () => {
    const { key, agent } = await angiSetup();
    const r1 = await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-1"));
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ duplicate: false, status: "queued", callQueued: true });
    const r2 = await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-1"));
    expect(r2.body.duplicate).toBe(true);
    // Run the job inside the calling window.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T15:00:00Z") });
    try { await createWorker({ handlers: { "lead.call": handlers["lead.call"] } }).drain(); } finally { vi.useRealTimers(); }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agentId: agent.providerAgentId, customerNumber: "+12125550142", customerName: "Maria Santos" });
    expect(calls[0].variableValues.lead_service).toBe("AC Repair");
    expect(calls[0].variableValues.profile).toMatch(/Name on file: Maria Santos/);
    expect(calls[0].variableValues.greeting_name).toBe("Maria");
    expect((await one("SELECT status, attempts, first_call_at FROM leads"))).toMatchObject({ status: "calling", attempts: 1 });
  });

  it("rules: outside the service area or on DNC is rejected; a wrong key is refused", async () => {
    const { key, owner } = await angiSetup();
    expect((await request(app).post(`/api/intake/angi/x`).set("x-api-key", "nope").send(angiLead("A-2"))).status).toBe(401);
    const far = await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-3", { postalCode: "94105" }));
    expect(far.body).toMatchObject({ status: "rejected", callQueued: false });
    expect(far.body.rejectReason).toMatch(/service area/);
    await owner.agent.post("/api/dnc").set(owner.csrf).send({ phone: "212-555-0188" });
    const dnc = await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-4", { primaryPhone: "2125550188" }));
    expect(dnc.body.rejectReason).toMatch(/do-not-call/);
  });

  it("a lead that arrives at night is called when the window opens, not before", async () => {
    const { key } = await angiSetup();
    await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-5"));
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T04:00:00Z") }); // 23:00 in New York
    try { await createWorker({ handlers: { "lead.call": handlers["lead.call"] } }).drain(); } finally { vi.useRealTimers(); }
    expect(calls).toHaveLength(0);
    const job = await one("SELECT status, run_at, attempts FROM jobs WHERE queue = 'lead.call'");
    expect(job!.status).toBe("queued");
    expect(job!.attempts).toBe(0);
    // Deferred by the time until 8:00 local (9 hours from 23:00), without spending an attempt.
    const deferredMs = new Date(job!.run_at).getTime() - Date.now();
    expect(deferredMs).toBeGreaterThan(8.9 * 3_600_000);
    expect(deferredMs).toBeLessThan(9.1 * 3_600_000);
  });

  it("a no-answer schedules the next attempt", async () => {
    const { key, agent } = await angiSetup();
    await request(app).post(`/api/intake/angi/x`).set("x-api-key", key).send(angiLead("A-6"));
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T15:00:00Z") });
    try { await createWorker({ handlers: { "lead.call": handlers["lead.call"] } }).drain(); } finally { vi.useRealTimers(); }
    const lead = await one("SELECT id FROM leads");
    const evt = analyzed("call_out_1", agent.providerAgentId, { outcome: "no_contact", turns: [], metadata: { lead_id: lead!.id } });
    evt.data.call.end_reason = "never_connected";
    evt.data.call.dial_outcome = "no_answer";
    await webhook(evt);
    expect((await one("SELECT status FROM leads"))!.status).toBe("queued");
    await createWorker({ handlers: { "lead.retry": handlers["lead.retry"] } }).drain();
    const next = await one("SELECT run_at FROM jobs WHERE queue = 'lead.call' AND status = 'queued'");
    expect(next).not.toBeNull();
  });
});

describe("dashboard and usage", () => {
  it("counts calls, bookings and charges per org", async () => {
    const { orgId, owner } = await setupOrg("Acme Heating", "ra_ok_a_0123456789");
    const agent = await liveAgent(owner, orgId);
    await webhook(analyzed("call_d1", agent.providerAgentId));
    await webhook(analyzed("call_d2", agent.providerAgentId, { outcome: "callback" }));
    const d = await owner.agent.get("/api/dashboard?days=7");
    expect(d.status).toBe(200);
    expect(d.body.calls).toMatchObject({ total: 2, booked: 1, charge_cents: 120 });
    const u = await owner.agent.get("/api/usage");
    expect(u.body).toMatchObject({ calls: 2, minutes: 4, charge_cents: 120, rateCentsPerMinute: 30 });
    const p = await admin.agent.get("/api/admin/usage");
    expect(p.body.orgs.find((o: any) => o.id === orgId).charge_cents).toBe(120);
  });
});
