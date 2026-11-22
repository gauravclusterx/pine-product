/**
 * Calls: the one place a call record is written (webhook and poller both come here), billed,
 * classified, scored and turned into follow-up work.
 *
 * Ownership comes from OUR data: a call belongs to the org that owns its agent — never to an
 * org named in a provider payload.
 */
import { one, q, tx } from "../db/pool.js";
import { log } from "../lib/logger.js";
import type { MappedExecution } from "../voice/rasen/mappers.js";
import { enqueue } from "../queue/queue.js";
import { agentByProviderId } from "./agents.js";
import { getOrg } from "./orgs.js";
import { setStatusFromCall, upsertCustomer } from "./customers.js";
import { scoreCall } from "./qa.js";
import { chargeUpTo, creditsForSeconds } from "./billing.js";
import { hintFor } from "./callHints.js";
import { analyseCall } from "./callAnalysis.js";
import { captureBookingFromCall } from "./bookingCapture.js";

const NO_CONTACT = new Set(["busy", "no_answer", "rejected", "invalid_number", "carrier_failed", "never_connected", "voicemail"]);

/** One outcome vocabulary for the dashboard, from the extraction or the way the call ended. */
export function outcomeOf(m: MappedExecution): string {
  const ex = m.extracted_data || {};
  if (ex.opted_out === true || ex.opted_out === "true") return "opt_out";
  const said = String(ex.outcome || "").toLowerCase();
  if (said && said !== "unknown") return said;
  const reason = String(m.ended_reason || "");
  if (NO_CONTACT.has(reason)) return "no_contact";
  if (reason === "transferred") return "transferred";
  return m.status === "ended" ? "unknown" : "";
}

/** Billed in whole minutes, rounded up; a call nobody spoke on costs nothing. */
export function chargeFor(billableSeconds: number, centsPerMinute: number): number {
  if (!(billableSeconds > 0)) return 0;
  return Math.ceil(billableSeconds / 60) * centsPerMinute;
}

export interface IngestResult { callId: string; orgId: string; created: boolean; ended: boolean; charged: number | null; outcome: string }

/**
 * Write what the provider reports about one call. Idempotent and order-safe: replays and
 * out-of-order deliveries never move a call backwards or bill it twice.
 */
export async function ingestCall(m: MappedExecution, opts: { expectOrgId?: string } = {}): Promise<IngestResult | null> {
  if (!m?.id || !m.agent_id) return null;
  const agent = await agentByProviderId(m.agent_id);
  if (!agent) { log.warn({ providerAgent: m.agent_id }, "call for an agent we do not know — ignored"); return null; }
  if (opts.expectOrgId && opts.expectOrgId !== agent.orgId) { log.warn({ call: m.id }, "call's agent belongs to another org — ignored"); return null; }
  const org = await getOrg(agent.orgId);
  const md = m.metadata || {};
  const direction = m.telephony_data.call_type;

  // The customer on the line. Outbound: the number we dialled. Inbound: the caller, recorded by
  // the before-call lookup moments before the call was created.
  let phone = direction === "inbound" ? m.telephony_data.from_number : m.telephony_data.to_number;
  if (direction === "inbound" && !phone) {
    const created = m.created_at ? new Date(m.created_at) : new Date();
    const hit = await one(
      `SELECT id, phone_e164 FROM inbound_lookups WHERE org_id = $1 AND provider_agent_id = $2 AND (provider_call_id = $3 OR (provider_call_id IS NULL
         AND created_at BETWEEN $4::timestamptz - interval '1 minute' AND $4::timestamptz + interval '5 minutes')) ORDER BY provider_call_id NULLS LAST, created_at DESC LIMIT 1`,
      [org.id, m.agent_id, m.id, created]
    );
    if (hit) {
      phone = hit.phone_e164;
      await q("UPDATE inbound_lookups SET provider_call_id = $2 WHERE id = $1 AND provider_call_id IS NULL", [hit.id, m.id]);
    }
  }
  // Outbound calls placed by a campaign (or before our own row was written): the hint knows the number.
  const hint = phone ? null : await hintFor(org.id, m.id);
  if (hint) phone = hint.phone;
  const purged = !!(await one("SELECT 1 AS x FROM calls WHERE org_id = $1 AND provider_call_id = $2 AND contact_purged", [org.id, m.id]));
  const customer = phone && !purged ? await upsertCustomer(org.id, { phone }) : null;
  const outcome = outcomeOf(m);
  const ended = m.status === "ended";
  const extraction = m.extracted_data || {};
  const uuidOrNull = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

  const res = await tx(async (t) => {
    const prev = (await t("SELECT id, status, provider_updated_at, results_final, charge_cents FROM calls WHERE org_id = $1 AND provider_call_id = $2 FOR UPDATE", [org.id, m.id]))[0];
    const providerUpdated = m.updated_at ? new Date(m.updated_at) : null;
    // An older snapshot than the one stored: keep the newer one.
    if (prev && prev.provider_updated_at && providerUpdated && providerUpdated < new Date(prev.provider_updated_at) && prev.results_final) {
      return { id: prev.id, created: false, charged: null as number | null, prevEnded: prev.status === "ended" };
    }
    const values = [
      org.id, m.id, agent.id, direction, purged ? null : hint?.customerId || customer?.id || null, uuidOrNull(md.lead_id) || hint?.leadId || null, uuidOrNull(md.campaign_id) || hint?.campaignId || null, phone || "",
      m.status, m.ended_reason, m.created_at || new Date().toISOString(), m.ended_at, m.conversation_time,
      JSON.stringify(m.transcript ? m.transcript.split("\n") : []), m.summary || "", JSON.stringify(extraction),
      !!m.telephony_data.recording_url, outcome || null, providerUpdated, m.results_final,
    ];
    const row = (await t(
      `INSERT INTO calls (org_id, provider_call_id, agent_id, direction, customer_id, lead_id, campaign_id, phone_e164,
          status, ended_reason, started_at, ended_at, duration_seconds, transcript, summary, extraction,
          recording_available, outcome, provider_updated_at, results_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (org_id, provider_call_id) DO UPDATE SET
         status = CASE WHEN calls.status = 'ended' THEN 'ended' ELSE EXCLUDED.status END,
         ended_reason = COALESCE(EXCLUDED.ended_reason, calls.ended_reason),
         ended_at = COALESCE(EXCLUDED.ended_at, calls.ended_at),
         duration_seconds = GREATEST(calls.duration_seconds, EXCLUDED.duration_seconds),
         transcript = CASE WHEN jsonb_array_length(EXCLUDED.transcript) > 0 THEN EXCLUDED.transcript ELSE calls.transcript END,
         summary = CASE WHEN EXCLUDED.summary <> '' THEN EXCLUDED.summary ELSE calls.summary END,
         extraction = CASE WHEN EXCLUDED.extraction <> '{}'::jsonb THEN EXCLUDED.extraction ELSE calls.extraction END,
         recording_available = calls.recording_available OR EXCLUDED.recording_available,
         outcome = COALESCE(NULLIF(EXCLUDED.outcome, 'unknown'), calls.outcome, EXCLUDED.outcome),
         customer_id = COALESCE(calls.customer_id, EXCLUDED.customer_id),
         phone_e164 = CASE WHEN calls.phone_e164 = '' THEN EXCLUDED.phone_e164 ELSE calls.phone_e164 END,
         provider_updated_at = GREATEST(calls.provider_updated_at, EXCLUDED.provider_updated_at),
         results_final = calls.results_final OR EXCLUDED.results_final,
         updated_at = now()
       RETURNING id, (xmax = 0) AS created, duration_seconds, status`,
      values
    ))[0];
    let charged: number | null = null;
    if (row.status === "ended") {
      // Compare-and-set: only the first writer that sees the call ended charges it.
      const billable = Math.max(0, Number(row.duration_seconds) || 0);
      const c = await t(
        "UPDATE calls SET billable_seconds = $2, charge_cents = $3 WHERE id = $1 AND charge_cents IS NULL RETURNING charge_cents",
        [row.id, billable, chargeFor(billable, org.rateCentsPerMinute)]
      );
      if (c[0]) charged = c[0].charge_cents;
      // Prepaid voice credits (CRM model): exact minutes, minimum 1 for a connected call, once per call.
      const credits = creditsForSeconds(billable);
      if (c[0] && credits > 0) {
        const claimed = await t("UPDATE calls SET billed_credits = $2 WHERE id = $1 AND billed_credits IS NULL RETURNING id", [row.id, credits]);
        if (claimed[0]) {
          const taken = await chargeUpTo(org.id, "voice", credits, "call", row.id, t);
          if (taken < credits) log.warn({ orgId: org.id, callId: row.id, credits, taken }, "voice credits ran out during a call");
        }
      }
    }
    return { id: row.id, created: row.created, charged, prevEnded: prev?.status === "ended" };
  });

  if (ended && !res.prevEnded) await afterCallEnded(org.id, res.id);
  if (m.results_final) await enqueue("call.finalise", { callId: res.id }, { orgId: org.id, dedupeKey: `finalise:${res.id}` });
  return { callId: res.id, orgId: org.id, created: res.created, ended, charged: res.charged, outcome };
}

/** Lead progress and opt-outs, the moment a call ends (once). */
async function afterCallEnded(orgId: string, callId: string): Promise<void> {
  const c = await one("SELECT * FROM calls WHERE id = $1", [callId]);
  if (!c) return;
  if (c.customer_id && c.outcome) await setStatusFromCall(c.customer_id, c.outcome);
  if (c.outcome === "opt_out" && c.phone_e164) {
    await q("INSERT INTO dnc_list (org_id, phone_e164, reason, source) VALUES ($1, $2, 'opt_out', 'call') ON CONFLICT DO NOTHING", [orgId, c.phone_e164]);
    await enqueue("voice.suppress", { phone: c.phone_e164 }, { orgId, dedupeKey: `suppress:${orgId}:${c.phone_e164}` });
  }
  if (c.lead_id) {
    const lead = await one("SELECT * FROM leads WHERE id = $1", [c.lead_id]);
    if (lead && lead.status !== "booked") {
      if (c.outcome === "no_contact") {
        await q("UPDATE leads SET status = 'queued', updated_at = now() WHERE id = $1", [lead.id]);
        await enqueue("lead.retry", { leadId: lead.id }, { orgId, dedupeKey: `lead-retry:${lead.id}:${lead.attempts}` });
      } else {
        const status = c.outcome === "not_interested" || c.outcome === "opt_out" ? "lost" : "contacted";
        await q("UPDATE leads SET status = $2, updated_at = now() WHERE id = $1", [lead.id, status]);
      }
    }
  }
}

/** Once every result has settled: score the call and raise second-chance work. Idempotent. */
export async function finaliseCall(callId: string): Promise<void> {
  // No usable outcome from the agent (e.g. an agent synced from Rasen): classify the transcript with AI, like the CRM.
  await analyseCall(callId);
  // The agent said it booked but its tool did not record it: capture the booking from the call (CRM bookingCapture).
  await captureBookingFromCall(callId);
  const c = await one("SELECT c.*, o.name AS org_name FROM calls c JOIN orgs o ON o.id = c.org_id WHERE c.id = $1", [callId]);
  if (!c) return;
  const transcript = Array.isArray(c.transcript) ? c.transcript.join("\n") : "";
  const qa = scoreCall({ transcript, outcome: c.outcome, extraction: c.extraction || {}, durationSeconds: c.duration_seconds, businessName: c.org_name });
  const already = c.qa && Object.keys(c.qa).length > 0;
  await q("UPDATE calls SET qa_score = $2, qa = $3, updated_at = now() WHERE id = $1", [callId, qa?.score ?? null, JSON.stringify(qa || { skipped: "no conversation" })]);
  if (!already && qa?.secondChance) {
    await q("INSERT INTO audit_log (org_id, action, detail) VALUES ($1, 'call.second_chance', $2)", [c.org_id, JSON.stringify({ callId, phone: String(c.phone_e164).slice(-4), summary: String(c.summary).slice(0, 300) })]);
  }
}

export interface CallListFilter { agentId?: string; outcome?: string; direction?: string; customerId?: string; from?: Date; to?: Date }

export async function listCalls(orgId: string, f: CallListFilter, limit: number, offset: number) {
  const where = ["c.org_id = $1"];
  const params: unknown[] = [orgId];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.agentId) add("c.agent_id = ?", f.agentId);
  if (f.outcome) add("c.outcome = ?", f.outcome);
  if (f.direction) add("c.direction = ?", f.direction);
  if (f.customerId) add("c.customer_id = ?", f.customerId);
  if (f.from) add("c.started_at >= ?", f.from);
  if (f.to) add("c.started_at < ?", f.to);
  params.push(limit, offset);
  return q(
    `SELECT c.id, c.provider_call_id, c.direction, c.phone_e164, c.status, c.ended_reason, c.started_at, c.duration_seconds, c.charge_cents,
            c.summary, c.outcome, c.qa_score, c.recording_available, a.name AS agent_name, cu.name AS customer_name
     FROM calls c LEFT JOIN agents a ON a.id = c.agent_id LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE ${where.join(" AND ")} ORDER BY c.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}
