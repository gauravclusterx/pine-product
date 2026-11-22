/**
 * Background work. Every handler is idempotent (the queue is at-least-once).
 *
 *   lead.call        speed-to-lead: call a new lead (waits for the window and the rate limit)
 *   lead.retry       schedule the next attempt after a no-answer
 *   call.finalise    score the call, flag second chances
 *   voice.suppress   add an opted-out number to the provider's campaign suppressions
 *   voice.sync       poll recent calls of one org (safety net for missed webhooks)
 *   lsa.poll         Google LSA has no push: poll each connected org every minute
 *   tick             the scheduler: fans out voice.sync / lsa.poll / campaign sync
 */
import { q, one } from "./db/pool.js";
import { log } from "./lib/logger.js";
import { createWorker, enqueue, PermanentJobError, type Handler, type Worker } from "./queue/queue.js";
import { getOrg, findOrg, leadAgentFor } from "./modules/orgs.js";
import { placeCall } from "./modules/outbound.js";
import { finaliseCall, ingestCall } from "./modules/calls.js";
import { analyseCall } from "./modules/callAnalysis.js";
import { captureBookingFromCall } from "./modules/bookingCapture.js";
import { leadVariables } from "./intake/leads.js";
import { acceptLead } from "./intake/leads.js";
import { fromLsaRow, LSA_QUERY } from "./intake/sources.js";
import { syncCampaign } from "./modules/campaigns.js";
import { findVoiceWorkspace } from "./modules/voiceWorkspace.js";
import { getIntegration, markIntegration } from "./hub/registry.js";
import { fetchHttp } from "./hub/http.js";
import { expectOk } from "./hub/types.js";
import * as rasen from "./voice/rasen/service.js";
import { config } from "./config.js";

export const handlers: Record<string, Handler> = {
  "lead.call": async (job) => {
    const lead = await one("SELECT * FROM leads WHERE id = $1", [job.payload.leadId]);
    if (!lead || ["booked", "lost", "rejected"].includes(lead.status)) return;
    const org = await getOrg(lead.org_id);
    const stl = org.settings.speedToLead;
    const agentId = leadAgentFor(org.settings, lead.source);
    if (!stl.enabled || !agentId) throw new PermanentJobError("speed to lead is off");
    if (lead.attempts >= stl.maxAttempts) { await q("UPDATE leads SET status = 'lost', updated_at = now() WHERE id = $1", [lead.id]); return; }
    try {
      await placeCall(org, { agentId, phone: lead.phone_e164, leadId: lead.id, variables: leadVariables(lead), idempotencyKey: `lead:${lead.id}:${lead.attempts}` });
    } catch (err) {
      if (err instanceof PermanentJobError) await q("UPDATE leads SET status = 'lost', reject_reason = $2, updated_at = now() WHERE id = $1", [lead.id, err.message]);
      throw err;
    }
    await q("UPDATE leads SET status = 'calling', attempts = attempts + 1, first_call_at = COALESCE(first_call_at, now()), updated_at = now() WHERE id = $1", [lead.id]);
  },

  "lead.retry": async (job) => {
    const lead = await one("SELECT * FROM leads WHERE id = $1", [job.payload.leadId]);
    if (!lead || lead.status === "booked") return;
    const org = await getOrg(lead.org_id);
    const stl = org.settings.speedToLead;
    if (lead.attempts >= stl.maxAttempts) { await q("UPDATE leads SET status = 'lost', updated_at = now() WHERE id = $1", [lead.id]); return; }
    const minutes = stl.retryMinutes[Math.min(lead.attempts - 1, stl.retryMinutes.length - 1)] ?? 60;
    await enqueue("lead.call", { leadId: lead.id }, { orgId: org.id, runAt: new Date(Date.now() + minutes * 60_000), dedupeKey: `lead-call:${lead.id}:${lead.attempts}`, maxAttempts: 20 });
  },

  "call.finalise": async (job) => { await finaliseCall(job.payload.callId); },

  /** After an AI key is saved: analyse the last week's calls that have no outcome or no captured booking. */
  "ai.backfill": async (job) => {
    const rows = await q(
      `SELECT c.id FROM calls c WHERE c.status = 'ended' AND jsonb_array_length(c.transcript) > 1 AND c.started_at > now() - interval '7 days'
         AND ($1::uuid IS NULL OR c.org_id = $1) AND (c.outcome IS NULL OR c.outcome IN ('unknown','booked'))
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.call_id = c.id) ORDER BY c.started_at DESC LIMIT 200`,
      [job.payload.orgId || null]
    );
    for (const r of rows) { await analyseCall(r.id); await captureBookingFromCall(r.id); }
  },

  "voice.suppress": async (job) => {
    const ws = await findVoiceWorkspace(job.orgId!);
    if (ws) await rasen.suppressDestination(ws, job.payload.phone, "opt_out");
  },

  "voice.sync": async (job) => {
    const ws = await findVoiceWorkspace(job.orgId!);
    if (!ws) return;
    // Calls still open in our records, plus the last hour at the provider.
    const open = await q("SELECT provider_call_id FROM calls WHERE org_id = $1 AND (status <> 'ended' OR NOT results_final) AND started_at > now() - interval '2 days' LIMIT 50", [job.orgId]);
    for (const c of open) {
      try {
        const m = await rasen.getMappedCall(ws, c.provider_call_id, { withUsage: true });
        await ingestCall(m, { expectOrgId: job.orgId! });
      } catch (err) {
        if ((err as any)?.status === 404) await q("UPDATE calls SET status = 'ended', results_final = true, ended_reason = COALESCE(ended_reason, 'never_connected') WHERE org_id = $1 AND provider_call_id = $2", [job.orgId, c.provider_call_id]);
        else throw err;
      }
    }
  },

  "lsa.poll": async (job) => {
    const org = await findOrg(job.orgId!);
    const lsa = org ? await getIntegration(org.id, "google_lsa") : null;
    if (!org || !lsa || lsa.status === "disabled") return;
    const { developerToken, clientId, clientSecret, refreshToken } = lsa.credentials;
    try {
      const tok = expectOk(await fetchHttp({
        method: "POST", url: "https://oauth2.googleapis.com/token", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
      }), "Google sign-in");
      const since = lsa.lastSyncAt ? new Date(lsa.lastSyncAt.getTime() - 5 * 60_000) : new Date(Date.now() - 60 * 60_000);
      const res = expectOk(await fetchHttp({
        method: "POST", url: `https://googleads.googleapis.com/v18/customers/${String(lsa.settings.customerId).replace(/\D/g, "")}/googleAds:search`,
        headers: { authorization: `Bearer ${tok.access_token}`, "developer-token": developerToken, "login-customer-id": String(lsa.settings.loginCustomerId).replace(/\D/g, "") },
        body: { query: LSA_QUERY(since.toISOString()) },
      }), "Google LSA query");
      for (const row of res.results || []) {
        const lead = fromLsaRow(row);
        if (lead.sourceRef && lead.phone) await acceptLead(org, lead);
      }
      await markIntegration(org.id, "google_lsa", true);
    } catch (err) {
      await markIntegration(org.id, "google_lsa", false, (err as Error).message);
      throw err;
    }
  },

  "campaign.sync": async (job) => {
    const org = await getOrg(job.orgId!);
    await syncCampaign(org, job.payload.campaignId);
  },

  tick: async () => {
    const minute = Math.floor(Date.now() / 60_000);
    // Polling is the safety net, not the main path: webhooks deliver results within seconds.
    for (const r of await q("SELECT org_id FROM voice_workspaces")) {
      await enqueue("voice.sync", {}, { orgId: r.org_id, dedupeKey: `voice-sync:${r.org_id}:${Math.floor(minute / 2)}` });
    }
    for (const r of await q("SELECT org_id FROM integrations WHERE kind = 'google_lsa' AND status <> 'disabled'")) {
      await enqueue("lsa.poll", {}, { orgId: r.org_id, dedupeKey: `lsa:${r.org_id}:${minute}` });
    }
    for (const r of await q("SELECT id, org_id FROM campaigns WHERE status IN ('running','scheduled','paused') OR (provider_campaign_id IS NOT NULL AND updated_at > now() - interval '6 hours')")) {
      await enqueue("campaign.sync", { campaignId: r.id }, { orgId: r.org_id, dedupeKey: `campaign-sync:${r.id}:${Math.floor(minute / 5)}` });
    }
    // Housekeeping.
    await q("DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '3 days'");
    await q("DELETE FROM rate_events WHERE at < now() - interval '5 minutes'");
    await q("DELETE FROM webhook_deliveries WHERE received_at < now() - interval '30 days'");
    await q("DELETE FROM inbound_lookups WHERE created_at < now() - interval '2 days'");
  },
};

let tickTimer: NodeJS.Timeout | null = null;

/** Start a worker; with `scheduler`, also enqueue the minute tick (one tick per minute cluster-wide). */
export function startWorker(opts: { scheduler?: boolean } = {}): Worker {
  const worker = createWorker({ handlers, concurrency: config.WORKER_CONCURRENCY });
  worker.start();
  if (opts.scheduler) {
    const schedule = () => enqueue("tick", {}, { dedupeKey: `tick:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 }).catch((err) => log.error({ err }, "tick enqueue failed"));
    schedule();
    tickTimer = setInterval(schedule, 20_000);
  }
  return {
    ...worker,
    stop: async () => { if (tickTimer) clearInterval(tickTimer); await worker.stop(); },
  };
}
