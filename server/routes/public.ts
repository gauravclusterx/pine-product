/**
 * Endpoints other systems call. None of them uses a session; each authenticates its caller:
 *
 *   POST /api/webhooks/voice              voice provider call events — Standard Webhooks signature
 *   POST /api/tools/:orgId/:tool          the agent's tools — the org's tool secret header
 *   POST /api/intake/:source/:key         lead pushes (Angi, Thumbtack, web forms, email) — per-integration key
 *   GET|POST /api/intake/meta/:orgId      Meta leadgen webhook — verify token / app-secret signature
 *   POST /api/intake/yelp/:key            Yelp webhook (lead ids only)
 */
import { Router } from "express";
import { one, q } from "../db/pool.js";
import { secretMatchesHash } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { h, P } from "../http.js";
import { config } from "../config.js";
import { verifyWebhookSignature, parseWebhookEnvelope, eventCallId } from "../voice/rasen/webhook.js";
import { mapRasenCall } from "../voice/rasen/mappers.js";
import * as rasen from "../voice/rasen/service.js";
import { findVoiceWorkspace, orgForWorkspace } from "../modules/voiceWorkspace.js";
import { ingestCall } from "../modules/calls.js";
import { findOrg } from "../modules/orgs.js";
import { runTool, STANDARD_TOOLS } from "../hub/service.js";
import { TOOL_SECRET_HEADER } from "../modules/agents.js";
import { integrationByInboundKey, getIntegration } from "../hub/registry.js";
import { fetchHttp } from "../hub/http.js";
import { acceptLead } from "../intake/leads.js";
import { fetchMetaLead, fetchYelpLead, fromAngi, fromThumbtack, fromWebForm, metaLeadIds, parseLeadEmail, verifyMetaSignature } from "../intake/sources.js";

export const publicRouter = Router();

// ── voice provider events ─────────────────────────────────────────────────────

publicRouter.post("/webhooks/voice", h(async (req, res) => {
  const raw = req.rawBody || Buffer.from("");
  const evt = parseWebhookEnvelope(raw);
  if (!evt) return res.status(400).json({ error: "not an event" });
  // The signing secret is the org's own (found by workspace id), with the env fallback.
  const owner = evt.workspace_id ? await orgForWorkspace(evt.workspace_id) : null;
  const verdict = verifyWebhookSignature(req.headers as any, raw, [owner?.webhookSecret, config.RASEN_WEBHOOK_SECRET]);
  if (!verdict.ok) {
    log.warn({ reason: verdict.reason, workspace: evt.workspace_id }, "voice webhook rejected");
    return res.status(401).json({ error: "invalid signature" });
  }
  // At-least-once delivery: the event id is the dedupe key.
  const fresh = await q(
    "INSERT INTO webhook_deliveries (provider, event_id, event_type, org_id) VALUES ('rasen', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id",
    [evt.id, evt.type, owner?.orgId || null]
  );
  if (!fresh.length) return res.json({ ok: true, duplicate: true });
  if (evt.type === "webhook.test") return res.json({ ok: true });
  if (!owner) return res.json({ ok: true, ignored: "unknown workspace" });

  const { callId, reduced } = eventCallId(evt);
  if (!callId) return res.json({ ok: true, ignored: "no call" });
  try {
    let mapped;
    if (reduced || !evt.data?.call) {
      const ws = await findVoiceWorkspace(owner.orgId);
      if (!ws) return res.json({ ok: true, ignored: "workspace disconnected" });
      mapped = await rasen.getMappedCall(ws, callId, { withUsage: true });
    } else {
      const d = evt.data;
      mapped = mapRasenCall(d.call, {
        turns: d.transcript?.turns ?? undefined, summary: d.summary ?? undefined, extraction: d.extraction ?? undefined,
        recordingAvailable: d.recording?.available ?? undefined, usageSeconds: d.usage?.telephony_seconds ?? undefined,
      });
      // The event has no billable seconds: read them once the call has ended.
      if (evt.type !== "call.failed" && d.call?.terminal && d.usage?.telephony_seconds === undefined) {
        const ws = await findVoiceWorkspace(owner.orgId);
        const secs = ws ? await rasen.getCallUsageSeconds(ws, callId).catch(() => null) : null;
        if (typeof secs === "number" && secs > 0) mapped.conversation_time = Math.round(secs);
      }
    }
    await ingestCall(mapped, { expectOrgId: owner.orgId });
    res.json({ ok: true });
  } catch (err) {
    // Let the provider retry: forget the delivery so the retry is processed.
    await q("DELETE FROM webhook_deliveries WHERE provider = 'rasen' AND event_id = $1", [evt.id]);
    throw err;
  }
}));

// ── agent tools ───────────────────────────────────────────────────────────────

publicRouter.post("/tools/:orgId/:tool", h(async (req, res) => {
  const { orgId, tool } = P(req);
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return res.status(404).json({ error: "unknown" });
  const ws = await one("SELECT tool_secret_hash FROM voice_workspaces WHERE org_id = $1", [orgId]);
  // Fails closed: no workspace, no secret, wrong secret → no data.
  if (!ws || !secretMatchesHash(String(req.header(TOOL_SECRET_HEADER) || ""), ws.tool_secret_hash)) return res.status(401).json({ error: "unauthorised" });
  if (!(STANDARD_TOOLS as readonly string[]).includes(tool)) return res.status(404).json({ error: "unknown tool" });
  const org = await findOrg(orgId);
  if (!org) return res.status(404).json({ error: "unknown" });
  const args = { ...(req.query as any), ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const providerAgentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
  // The agent id is a constant we set; it must be one of this org's agents.
  if (providerAgentId && !(await one("SELECT 1 AS x FROM agents WHERE org_id = $1 AND provider_agent_id = $2", [orgId, providerAgentId]))) {
    return res.status(403).json({ error: "agent does not belong to this workspace" });
  }
  const callId = String(req.header("x-rasen-call-id") || args.call_id || "") || undefined;
  const out = await runTool(org, tool, args, { providerAgentId, providerCallId: callId });
  res.json({ result: out.result, ...(out.data || {}) });
}));

// ── lead intake ───────────────────────────────────────────────────────────────

const PUSH_SOURCES: Record<string, (body: any) => any> = { angi: fromAngi, thumbtack: fromThumbtack, web_form: fromWebForm };

publicRouter.post("/intake/:source/:key", h(async (req, res, next) => {
  const { source, key } = P(req);
  if (source === "meta" || source === "yelp") return next();
  const adapter = PUSH_SOURCES[source];
  if (!adapter && source !== "email_parse") return res.status(404).json({ error: "unknown source" });
  // Angi sends its key in X-API-KEY; others use the URL.
  const presented = String(req.header("x-api-key") || key || "");
  const integ = await integrationByInboundKey(source, presented);
  if (!integ) return res.status(401).json({ error: "unknown key" });
  const org = await findOrg(integ.orgId);
  if (!org) return res.status(404).json({ error: "unknown" });
  let lead;
  if (source === "email_parse") {
    lead = parseLeadEmail({ from: String(req.body?.from || ""), subject: String(req.body?.subject || ""), text: String(req.body?.text || req.body?.plain || ""), messageId: String(req.body?.messageId || req.body?.["message-id"] || Date.now()) });
    if (!lead) return res.status(202).json({ ok: false, reason: "no phone number found in the email" });
  } else {
    lead = adapter(req.body || {});
  }
  if (!lead.sourceRef) return res.status(400).json({ error: "the lead has no id" });
  const r = await acceptLead(org, lead);
  res.status(r.duplicate ? 200 : 201).json(r);
}));

// Meta: subscription check, then signed leadgen notifications (ids only).
publicRouter.get("/intake/meta/:orgId", h(async (req, res) => {
  const integ = await getIntegration(P(req).orgId, "meta").catch(() => null);
  const expected = integ?.settings?.verifyToken;
  if (req.query["hub.mode"] === "subscribe" && expected && req.query["hub.verify_token"] === expected) return res.status(200).send(String(req.query["hub.challenge"] || ""));
  res.status(403).send("forbidden");
}));

publicRouter.post("/intake/meta/:orgId", h(async (req, res) => {
  const integ = /^[0-9a-f-]{36}$/i.test(P(req).orgId) ? await getIntegration(P(req).orgId, "meta") : null;
  if (!integ || !verifyMetaSignature(req.rawBody || Buffer.from(""), req.header("x-hub-signature-256"), integ.credentials.appSecret)) return res.status(401).json({ error: "invalid signature" });
  const org = await findOrg(integ.orgId);
  if (!org) return res.status(404).end();
  const results = [];
  for (const ref of metaLeadIds(req.body)) {
    if (integ.settings.pageId && ref.pageId && ref.pageId !== String(integ.settings.pageId)) continue;
    const lead = await fetchMetaLead(fetchHttp, ref.leadgenId, integ.credentials.pageAccessToken);
    results.push(await acceptLead(org, lead));
  }
  res.json({ ok: true, leads: results.length });
}));

publicRouter.post("/intake/yelp/:key", h(async (req, res) => {
  const integ = await integrationByInboundKey("yelp", P(req).key);
  if (!integ) return res.status(401).json({ error: "unknown key" });
  const org = await findOrg(integ.orgId);
  if (!org) return res.status(404).end();
  const ids: string[] = [];
  for (const u of req.body?.data?.updates || []) if (u?.lead_id) ids.push(String(u.lead_id));
  let n = 0;
  for (const id of Array.from(new Set(ids))) {
    const lead = await fetchYelpLead(fetchHttp, id, integ.credentials.accessToken);
    if (lead.phone) { await acceptLead(org, lead); n++; }
  }
  res.json({ ok: true, leads: n });
}));
