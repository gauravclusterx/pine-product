/** The signed-in API used by the web app. Every handler acts on `req.auth.orgId` only. */
import { Router, type Request } from "express";
import { z } from "zod";
import { one, q, tx } from "../db/pool.js";
import { badRequest, notFound, tooMany, unauthorized } from "../lib/errors.js";
import { h, P, paging, parse, uuid } from "../http.js";
import {
  audit, clearSessionCookie, hashPassword, passwordProblem, requireAuth, requirePlatformAdmin, requireRole,
  setSessionCookie, signSession, verifyPassword,
} from "../auth/auth.js";
import { toE164 } from "../lib/phone.js";
import { newSecret } from "../lib/crypto.js";
import { createOrg, createOrgSchema, getOrg, updateOrg, updateOrgSchema } from "../modules/orgs.js";
import { connectVoiceWorkspace, disconnectVoiceWorkspace, requireVoiceWorkspace, voiceStatus, webhookUrl } from "../modules/voiceWorkspace.js";
import * as agents from "../modules/agents.js";
import { PLAYBOOKS } from "../voice/playbooks.js";
import { listCalls } from "../modules/calls.js";
import { placeCall } from "../modules/outbound.js";
import { getCustomer, updateCustomer } from "../modules/customers.js";
import { acceptLead, leadInputSchema, listLeads } from "../intake/leads.js";
import * as campaigns from "../modules/campaigns.js";
import { orgBilling, requireCurrentSubscription } from "../modules/billing.js";
import { billingRouter, createCustomerWorkspace } from "./billing.js";
import { crmRouter } from "./crm.js";
import { aiRouter } from "./ai.js";
import { dashboard, platformOverview, platformUsage, usage } from "../modules/stats.js";
import { translateCall, translationAvailable } from "../modules/translate.js";
import { CHANNELS, CRM_CONNECTORS, connectorContext, deleteIntegration, listIntegrations, markIntegration, rotateInboundKey, saveIntegration, saveIntegrationSchema } from "../hub/registry.js";
import { queueStats, DeferJob, PermanentJobError } from "../queue/queue.js";
import * as rasen from "../voice/rasen/service.js";
import { isProd, isTest, publicBaseUrl } from "../config.js";
import crypto from "node:crypto";
import { log } from "../lib/logger.js";
import { adminEmails, STATE_COOKIE, allowedDomains, authUrl, decideSignIn, fetchGoogleProfile, googleConfigured, newState, requestOrigin } from "../auth/google.js";

export const apiRouter = Router();
const org = (req: Request) => getOrg(req.auth!.orgId);

// ── auth ──────────────────────────────────────────────────────────────────────

const attempts = new Map<string, { n: number; until: number }>();
function throttleLogin(key: string): void {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.until > now && a.n >= 8) throw tooMany("Too many sign-in attempts. Wait a few minutes.", Math.ceil((a.until - now) / 1000));
  attempts.set(key, { n: a && a.until > now ? a.n + 1 : 1, until: a && a.until > now ? a.until : now + 10 * 60_000 });
}

// Google is the only sign-in. GET /auth/google starts it; Google returns to the callback.
apiRouter.get("/auth/google", (req, res) => {
  if (!googleConfigured()) return res.redirect("/login?error=not_configured");
  const state = newState();
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: isProd, path: "/api/auth/google", maxAge: 10 * 60_000 });
  res.redirect(authUrl(requestOrigin(req), state));
});

apiRouter.get("/auth/google/callback", async (req, res) => {
  const fail = (reason: string) => res.redirect(`/login?error=${encodeURIComponent(reason)}`);
  try {
    const state = String(req.query.state || "");
    const expected = String((req as any).cookies?.[STATE_COOKIE] || "");
    res.clearCookie(STATE_COOKIE, { path: "/api/auth/google" });
    if (req.query.error) return fail("cancelled");
    if (!state || !expected || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) return fail("expired");
    const g = await fetchGoogleProfile(String(req.query.code || ""), requestOrigin(req));
    let user = await one("SELECT * FROM users WHERE lower(email) = lower($1)", [g.email]);
    const d = decideSignIn(g, user ? { disabled: !!user.disabled } : null);
    if (!d.ok) return fail(d.reason);
    if (!user) {
      // First sign-in creates the account (no usable password). A customer also gets a workspace.
      user = await one("INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING *", [g.email, g.name, "google-only", d.admin]);
      if (!d.admin) await createCustomerWorkspace(user!.id, g.name, g.email);
      await audit(null, user!.id, "user.created_by_google", { email: g.email, admin: d.admin });
    } else if (adminEmails().length && !!user.is_platform_admin !== d.admin) {
      // The admin list is the source of truth for who is staff.
      await q("UPDATE users SET is_platform_admin = $2 WHERE id = $1", [user.id, d.admin]);
      if (!d.admin && !(await one("SELECT 1 AS x FROM memberships WHERE user_id = $1", [user.id]))) await createCustomerWorkspace(user.id, g.name, g.email);
    }
    await q("UPDATE users SET last_login_at = now(), name = CASE WHEN name = '' THEN $2 ELSE name END WHERE id = $1", [user!.id, g.name]);
    setSessionCookie(res, signSession(user!.id, user!.token_version));
    res.redirect(d.admin ? "/admin" : "/app");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "google sign-in failed");
    fail("google_failed");
  }
});

apiRouter.get("/auth/options", (_req, res) => {
  res.json({ google: googleConfigured(), domains: allowedDomains() });
});

// Password sign-in exists only for the automated tests.
apiRouter.post("/auth/login", h(async (req, res) => {
  if (!isTest) throw notFound();
  const { email, password } = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req.body);
  throttleLogin(`${req.ip}:${email.toLowerCase()}`);
  const user = await one("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  // Same answer and similar time for "no such user" and "wrong password".
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, "$2a$12$" + "x".repeat(53)).catch(() => false);
  if (!user || !ok || user.disabled) throw unauthorized("Email or password is not right.");
  attempts.delete(`${req.ip}:${email.toLowerCase()}`);
  await q("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  const token = signSession(user.id, user.token_version);
  setSessionCookie(res, token);
  res.json({ ok: true, token });
}));

apiRouter.post("/auth/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

apiRouter.use(requireAuth);
// Suspended or unpaid (paywall on) clients reach only sign-in, billing and their workspace profile.
apiRouter.use(requireCurrentSubscription(["/auth/", "/billing", "/org"]));
apiRouter.use(billingRouter);
apiRouter.use(crmRouter);
apiRouter.use(aiRouter);

apiRouter.get("/auth/me", h(async (req, res) => {
  const a = req.auth!;
  const orgs = a.isPlatformAdmin
    ? await q("SELECT id, name, slug, 'owner' AS role FROM orgs ORDER BY name")
    : await q("SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name", [a.userId]);
  const billing = a.orgId ? await orgBilling(a.orgId) : null;
  res.json({ user: { id: a.userId, email: a.email, name: a.name, isPlatformAdmin: a.isPlatformAdmin }, orgId: a.orgId, role: a.role, orgs, billing });
}));

apiRouter.post("/auth/password", h(async (req, res) => {
  if (!isTest) throw notFound();
  const { current, next } = parse(z.object({ current: z.string(), next: z.string() }), req.body);
  const problem = passwordProblem(next);
  if (problem) throw badRequest(problem);
  const user = (await one("SELECT * FROM users WHERE id = $1", [req.auth!.userId]))!;
  if (!(await verifyPassword(current, user.password_hash))) throw badRequest("The current password is not right.");
  const updated = await one("UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING token_version", [user.id, await hashPassword(next)]);
  setSessionCookie(res, signSession(user.id, updated!.token_version));
  await audit(null, user.id, "user.password_changed");
  res.json({ ok: true });
}));

// ── platform staff ────────────────────────────────────────────────────────────

apiRouter.get("/admin/orgs", requirePlatformAdmin, h(async (_req, res) => {
  res.json({ orgs: await q(`SELECT o.id, o.name, o.slug, o.industry, o.status, o.rate_cents_per_minute, o.created_at, (v.org_id IS NOT NULL) AS voice_connected,
    (SELECT count(*)::int FROM agents a WHERE a.org_id = o.id AND a.status = 'live') AS live_agents
    FROM orgs o LEFT JOIN voice_workspaces v ON v.org_id = o.id ORDER BY o.created_at DESC`) });
}));

apiRouter.post("/admin/orgs", requirePlatformAdmin, h(async (req, res) => {
  const input = parse(createOrgSchema.extend({ ownerEmail: z.string().email(), ownerName: z.string().trim().max(120).default("") }), req.body);
  const o = await createOrg(input);
  // The owner gets a one-time password shown to staff once; they change it at first sign-in.
  const tempPassword = newSecret(9) + "7a";
  await tx(async (t) => {
    const existing = (await t("SELECT id FROM users WHERE lower(email) = lower($1)", [input.ownerEmail]))[0];
    const userId = existing?.id || (await t("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [input.ownerEmail, input.ownerName, await hashPassword(tempPassword)]))[0].id;
    await t("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [o.id, userId]);
    if (existing) (input as any).existing = true;
  });
  await audit(o.id, req.auth!.userId, "org.created", { name: o.name });
  // No password is handed out: the owner signs in with Google using this email.
  res.status(201).json({ org: o, owner: { email: input.ownerEmail, existing: !!(input as any).existing } });
}));

apiRouter.put("/admin/orgs/:id/voice-key", requirePlatformAdmin, h(async (req, res) => {
  const { apiKey, webhookSecret } = parse(z.object({ apiKey: z.string().min(12).max(400), webhookSecret: z.string().max(400).optional() }), req.body);
  const id = parse(uuid, P(req).id);
  await getOrg(id);
  const r = await connectVoiceWorkspace(id, apiKey, { webhookSecret });
  await audit(id, req.auth!.userId, "voice.connected", { workspaceId: r.workspaceId });
  res.json(r);
}));

apiRouter.delete("/admin/orgs/:id/voice-key", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  await disconnectVoiceWorkspace(id);
  await audit(id, req.auth!.userId, "voice.disconnected");
  res.json({ ok: true });
}));

apiRouter.put("/admin/orgs/:id/rate", requirePlatformAdmin, h(async (req, res) => {
  const { centsPerMinute } = parse(z.object({ centsPerMinute: z.number().int().min(0).max(10_000) }), req.body);
  const r = await one("UPDATE orgs SET rate_cents_per_minute = $2, updated_at = now() WHERE id = $1 RETURNING id", [parse(uuid, P(req).id), centsPerMinute]);
  if (!r) throw notFound();
  res.json({ ok: true });
}));

apiRouter.put("/admin/orgs/:id/status", requirePlatformAdmin, h(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["active", "paused", "churned"]) }), req.body);
  await q("UPDATE orgs SET status = $2, updated_at = now() WHERE id = $1", [parse(uuid, P(req).id), status]);
  res.json({ ok: true });
}));

apiRouter.get("/admin/usage", requirePlatformAdmin, h(async (req, res) => {
  const { from, to } = monthRange(String(req.query.month || ""));
  res.json({ from, to, orgs: await platformUsage(from, to) });
}));

apiRouter.get("/admin/overview", requirePlatformAdmin, h(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const to = new Date();
  res.json(await platformOverview(new Date(to.getTime() - days * 86_400_000), to));
}));

apiRouter.get("/admin/queue", requirePlatformAdmin, h(async (_req, res) => {
  res.json({ queues: await queueStats(), dead: await q("SELECT id, queue, org_id, attempts, last_error, finished_at FROM jobs WHERE status = 'dead' ORDER BY finished_at DESC LIMIT 50") });
}));

function monthRange(month: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const now = new Date();
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getUTCMonth();
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)) };
}

// ── the org ───────────────────────────────────────────────────────────────────

const viewer = requireRole("viewer");
const manager = requireRole("manager");
const owner = requireRole("owner");

apiRouter.get("/org", viewer, h(async (req, res) => {
  res.json({ org: await org(req), voice: await voiceStatus(req.auth!.orgId), webhookUrl: webhookUrl(), translation: await translationAvailable(req.auth!.orgId) });
}));

apiRouter.patch("/org", manager, h(async (req, res) => {
  const patch = parse(updateOrgSchema, req.body);
  const updated = await updateOrg(req.auth!.orgId, patch);
  await audit(updated.id, req.auth!.userId, "org.updated", { fields: Object.keys(patch.settings || {}).concat(Object.keys(patch).filter((k) => k !== "settings")) });
  // Agents quote hours, services and areas: keep live agents in step.
  let republished = null;
  if (patch.settings || patch.name || patch.timezone) republished = await agents.republishLiveAgents(updated.id).catch(() => null);
  res.json({ org: updated, republished });
}));

apiRouter.get("/org/members", viewer, h(async (req, res) => {
  res.json({ members: await q("SELECT u.id, u.email, u.name, m.role, u.last_login_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.email", [req.auth!.orgId]) });
}));

apiRouter.post("/org/members", owner, h(async (req, res) => {
  const { email, name, role } = parse(z.object({ email: z.string().email(), name: z.string().max(120).default(""), role: z.enum(["owner", "manager", "viewer"]).default("manager") }), req.body);
  const temp = newSecret(9) + "7a";
  const user = (await one("SELECT id FROM users WHERE lower(email) = lower($1)", [email])) || (await one("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [email, name, await hashPassword(temp)]));
  const created = !(await one("SELECT 1 AS x FROM memberships WHERE org_id = $1 AND user_id = $2", [req.auth!.orgId, user!.id]));
  await q("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role", [req.auth!.orgId, user!.id, role]);
  res.status(201).json({ ok: true, created: !!created });
}));

apiRouter.delete("/org/members/:userId", owner, h(async (req, res) => {
  const userId = parse(uuid, P(req).userId);
  if (userId === req.auth!.userId) throw badRequest("You cannot remove yourself.");
  await q("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [req.auth!.orgId, userId]);
  res.json({ ok: true });
}));

// ── voice ─────────────────────────────────────────────────────────────────────

apiRouter.get("/voice/voices", viewer, h(async (req, res) => {
  res.json({ voices: await rasen.listVoices(await requireVoiceWorkspace(req.auth!.orgId)) });
}));

apiRouter.get("/voice/numbers", viewer, h(async (req, res) => {
  // Not connected yet: an empty list with a reason, not an error page.
  if (!(await one("SELECT 1 AS x FROM voice_workspaces WHERE org_id = $1", [req.auth!.orgId]))) return res.json({ numbers: [], connected: false });
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const remote = await rasen.listMappedPhoneNumbers(ws);
  for (const n of remote) {
    await q(
      `INSERT INTO phone_numbers (org_id, provider_number_id, e164, label, supports_inbound, supports_outbound, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (org_id, provider_number_id) DO UPDATE SET e164 = EXCLUDED.e164, label = EXCLUDED.label, supports_inbound = EXCLUDED.supports_inbound, supports_outbound = EXCLUDED.supports_outbound, synced_at = now()`,
      [req.auth!.orgId, n.id, n.phone_number, n.name || "", n.supports_inbound, n.supports_outbound]
    );
  }
  res.json({ numbers: await q("SELECT p.*, a.name AS inbound_agent_name FROM phone_numbers p LEFT JOIN agents a ON a.id = p.inbound_agent_id WHERE p.org_id = $1 ORDER BY p.e164", [req.auth!.orgId]) });
}));

apiRouter.put("/voice/numbers/:id/inbound", manager, h(async (req, res) => {
  const { agentId } = parse(z.object({ agentId: z.string().uuid().nullable() }), req.body);
  const num = await one("SELECT * FROM phone_numbers WHERE org_id = $1 AND id = $2", [req.auth!.orgId, parse(uuid, P(req).id)]);
  if (!num) throw notFound("Number not found.");
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  if (!agentId) {
    await rasen.removeInboundAgent(ws, num.provider_number_id);
    await q("UPDATE phone_numbers SET inbound_agent_id = NULL, inbound_setup = NULL WHERE id = $1", [num.id]);
    return res.json({ ok: true });
  }
  const agent = await agents.getAgent(req.auth!.orgId, agentId);
  if (agent.status !== "live" || !agent.providerAgentId) throw badRequest("Publish the agent first.");
  const r = await rasen.setInboundAgent(ws, num.provider_number_id, agent.providerAgentId);
  await q("UPDATE phone_numbers SET inbound_agent_id = $2, inbound_setup = $3 WHERE id = $1", [num.id, agent.id, r.setupState]);
  res.json({ ok: true, setupState: r.setupState, nextAction: r.nextAction });
}));

// ── agents ────────────────────────────────────────────────────────────────────

apiRouter.get("/playbooks", viewer, (_req, res) => { res.json({ playbooks: PLAYBOOKS }); });

apiRouter.get("/agents", viewer, h(async (req, res) => { res.json({ agents: await agents.listAgents(req.auth!.orgId) }); }));

apiRouter.post("/agents", manager, h(async (req, res) => {
  const a = await agents.createAgent(await org(req), parse(agents.createAgentSchema, req.body));
  await audit(a.orgId, req.auth!.userId, "agent.created", { agentId: a.id, name: a.name });
  res.status(201).json({ agent: a });
}));

apiRouter.get("/agents/:id", viewer, h(async (req, res) => {
  const o = await org(req);
  const a = await agents.getAgent(o.id, parse(uuid, P(req).id));
  res.json({ agent: a, preview: agents.providerConfig(o, a), tools: a.config.tools?.length ? a.config.tools : agents.toolsFor(a.playbook) });
}));

apiRouter.patch("/agents/:id", manager, h(async (req, res) => {
  res.json({ agent: await agents.updateAgent(await org(req), parse(uuid, P(req).id), parse(agents.updateAgentSchema, req.body)) });
}));

apiRouter.post("/agents/:id/publish", manager, h(async (req, res) => {
  const a = await agents.publishAgent(await org(req), parse(uuid, P(req).id));
  await audit(a.orgId, req.auth!.userId, "agent.published", { agentId: a.id, version: a.liveVersionId });
  res.json({ agent: a });
}));

apiRouter.get("/agents/:id/readiness", viewer, h(async (req, res) => { res.json(await agents.readiness(await org(req), parse(uuid, P(req).id))); }));
apiRouter.post("/agents/:id/test-link", manager, h(async (req, res) => { res.json(await agents.testCallLink(await org(req), parse(uuid, P(req).id))); }));
apiRouter.post("/agents/:id/pause", manager, h(async (req, res) => { res.json({ agent: await agents.pauseAgent(await org(req), parse(uuid, P(req).id)) }); }));
apiRouter.delete("/agents/:id", owner, h(async (req, res) => {
  await agents.archiveAgent(await org(req), parse(uuid, P(req).id));
  res.json({ ok: true });
}));

// ── calls ─────────────────────────────────────────────────────────────────────

apiRouter.get("/calls", viewer, h(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const f = parse(z.object({
    agentId: z.string().uuid().optional(), outcome: z.string().max(40).optional(), direction: z.enum(["inbound", "outbound", "web"]).optional(),
    customerId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  }), req.query);
  res.json({ calls: await listCalls(req.auth!.orgId, f, limit, offset) });
}));

apiRouter.get("/calls/:id", viewer, h(async (req, res) => {
  const c = await one(
    `SELECT c.*, a.name AS agent_name, cu.name AS customer_name FROM calls c LEFT JOIN agents a ON a.id = c.agent_id LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE c.org_id = $1 AND c.id = $2`, [req.auth!.orgId, parse(uuid, P(req).id)]);
  if (!c) throw notFound("Call not found.");
  res.json({ call: c });
}));

apiRouter.post("/calls/:id/translate", viewer, h(async (req, res) => {
  res.json(await translateCall(req.auth!.orgId, parse(uuid, P(req).id), { refresh: req.query.refresh === "1" }));
}));

/** Recording audio, relayed from the provider (which has no public URLs) with Range support. */
apiRouter.get("/calls/:id/recording", viewer, h(async (req, res) => {
  const c = await one("SELECT provider_call_id FROM calls WHERE org_id = $1 AND id = $2", [req.auth!.orgId, parse(uuid, P(req).id)]);
  if (!c) throw notFound("Call not found.");
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const r = await rasen.openCallRecording(ws, c.provider_call_id, typeof req.headers.range === "string" ? req.headers.range : undefined);
  res.status(r.status);
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) if (r.headers[k]) res.setHeader(k, r.headers[k]);
  res.setHeader("cache-control", "private, no-store");
  r.stream.pipe(res);
}));

apiRouter.post("/calls", manager, h(async (req, res) => {
  const { agentId, phone } = parse(z.object({ agentId: z.string().uuid(), phone: z.string().min(5).max(40) }), req.body);
  const o = await org(req);
  const e164 = toE164(phone, o.settings.defaultCountryCode);
  if (!e164) throw badRequest("Enter the full phone number.");
  try {
    const r = await placeCall(o, { agentId, phone: e164, manual: true, idempotencyKey: `manual:${req.auth!.userId}:${e164}:${Math.floor(Date.now() / 60_000)}` });
    await audit(o.id, req.auth!.userId, "call.manual", { to: e164.slice(-4) });
    res.status(202).json(r);
  } catch (err) {
    if (err instanceof DeferJob) throw badRequest(err.message === "outside the calling window" ? "It is outside the calling window for this business." : "The call-start limit is reached. Try again in a minute.");
    if (err instanceof PermanentJobError) throw badRequest(err.message);
    throw err;
  }
}));

// ── customers, leads, bookings ────────────────────────────────────────────────

apiRouter.get("/bookings", viewer, h(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86_400_000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 86_400_000);
  res.json({ bookings: await q(
    `SELECT b.*, c.name AS customer_name, c.phone_e164 FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.org_id = $1 AND b.starts_at >= $2 AND b.starts_at < $3 ORDER BY b.starts_at`, [req.auth!.orgId, from, to]) });
}));

apiRouter.get("/dnc", viewer, h(async (req, res) => { res.json({ entries: await q("SELECT * FROM dnc_list WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1000", [req.auth!.orgId]) }); }));
apiRouter.post("/dnc", manager, h(async (req, res) => {
  const o = await org(req);
  const { phone, reason } = parse(z.object({ phone: z.string().max(40), reason: z.string().max(60).default("opt_out") }), req.body);
  const e164 = toE164(phone, o.settings.defaultCountryCode);
  if (!e164) throw badRequest("Enter a valid phone number.");
  await q("INSERT INTO dnc_list (org_id, phone_e164, reason, source) VALUES ($1, $2, $3, 'manual') ON CONFLICT (org_id, phone_e164) DO UPDATE SET reason = EXCLUDED.reason", [o.id, e164, reason]);
  res.status(201).json({ ok: true, phone: e164 });
}));
apiRouter.delete("/dnc/:phone", owner, h(async (req, res) => {
  await q("DELETE FROM dnc_list WHERE org_id = $1 AND phone_e164 = $2", [req.auth!.orgId, P(req).phone]);
  res.json({ ok: true });
}));

// ── campaigns ─────────────────────────────────────────────────────────────────

apiRouter.get("/campaigns", viewer, h(async (req, res) => { res.json({ campaigns: await campaigns.listCampaigns(req.auth!.orgId) }); }));
apiRouter.post("/campaigns", manager, h(async (req, res) => {
  const c = await campaigns.createCampaign(await org(req), req.auth!.userId, parse(campaigns.createCampaignSchema, req.body));
  await audit(req.auth!.orgId, req.auth!.userId, "campaign.created", { campaignId: c.id, recipients: c.recipient_count });
  res.status(201).json({ campaign: c });
}));
apiRouter.post("/campaigns/:id/:command", manager, h(async (req, res) => {
  const command = parse(z.enum(["start", "pause", "resume", "cancel"]), P(req).command);
  res.json({ campaign: await campaigns.campaignCommand(await org(req), parse(uuid, P(req).id), command) });
}));

// ── integrations ──────────────────────────────────────────────────────────────

apiRouter.get("/integrations/catalog", viewer, (_req, res) => {
  const crm = Object.values(CRM_CONNECTORS).map((c) => ({ kind: c.kind, label: c.label, group: "schedule", maturity: c.maturity, credentialFields: c.credentialFields, settingFields: c.settingFields || [], accessNote: c.accessNote || null }));
  const channels = Object.values(CHANNELS).map((c) => ({ ...c, settingFields: c.settingFields || [], accessNote: c.accessNote || null }));
  res.json({ catalog: [...crm, ...channels] });
});

apiRouter.get("/integrations", viewer, h(async (req, res) => {
  const list = await listIntegrations(req.auth!.orgId);
  const base = publicBaseUrl();
  res.json({
    integrations: list,
    endpoints: {
      angi: `${base}/api/intake/angi/<key>`, thumbtack: `${base}/api/intake/thumbtack/<key>`, web_form: `${base}/api/intake/web_form/<key>`,
      email_parse: `${base}/api/intake/email_parse/<key>`, twilio: `${base}/api/webhooks/sms/<key>`, meta: `${base}/api/intake/meta/${req.auth!.orgId}`, yelp: `${base}/api/intake/yelp/<key>`,
    },
  });
}));

apiRouter.put("/integrations/:kind", manager, h(async (req, res) => {
  const r = await saveIntegration(req.auth!.orgId, P(req).kind, parse(saveIntegrationSchema, req.body));
  await audit(req.auth!.orgId, req.auth!.userId, "integration.saved", { kind: P(req).kind });
  res.json({ ok: true, inboundKey: r.inboundKey });
}));

apiRouter.post("/integrations/:kind/test", manager, h(async (req, res) => {
  const o = await org(req);
  const kind = P(req).kind;
  if (!CRM_CONNECTORS[kind]) return res.json({ ok: true, detail: "Saved. This integration is checked when it is first used." });
  try {
    const { connector, ctx } = await connectorContext(o, kind);
    await connector.test(ctx);
    await markIntegration(o.id, kind, true);
    res.json({ ok: true, detail: `${connector.label} answered.` });
  } catch (err) {
    await markIntegration(o.id, kind, false, (err as Error).message);
    res.status(422).json({ ok: false, detail: (err as Error).message });
  }
}));

apiRouter.post("/integrations/:kind/rotate-key", owner, h(async (req, res) => { res.json({ inboundKey: await rotateInboundKey(req.auth!.orgId, P(req).kind) }); }));
apiRouter.delete("/integrations/:kind", owner, h(async (req, res) => { await deleteIntegration(req.auth!.orgId, P(req).kind); res.json({ ok: true }); }));

// ── dashboard, usage ──────────────────────────────────────────────────────────

apiRouter.get("/dashboard", viewer, h(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const to = new Date();
  res.json(await dashboard(req.auth!.orgId, new Date(to.getTime() - days * 86_400_000), to));
}));

apiRouter.get("/usage", viewer, h(async (req, res) => {
  const { from, to } = monthRange(String(req.query.month || ""));
  const o = await org(req);
  res.json({ from, to, rateCentsPerMinute: o.rateCentsPerMinute, ...(await usage(o.id, from, to)) });
}));
