/**
 * Who is on a call — the one place that answers it for every path (like the CRM's VoiceCallHint):
 *   • a call we dial (single call, speed to lead, retries) → remembered when the provider returns its id
 *   • a campaign call → read from the campaign's recipient list (each attempt carries the call id)
 *   • an inbound call → the before-call lookup (handled in calls.ts)
 * When a hint arrives after the call was already stored, the call is completed in place: phone,
 * contact, campaign, and the contact's status from the call outcome.
 */
import { one, q } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { setStatusFromCall, upsertCustomer } from "./customers.js";

export interface Hint { phone: string; customerId: string | null; leadId: string | null; campaignId: string | null }

export async function rememberHint(orgId: string, providerCallId: string, h: { phone: string; customerId?: string | null; leadId?: string | null; campaignId?: string | null }): Promise<void> {
  if (!providerCallId || !h.phone) return;
  await q(
    `INSERT INTO call_hints (org_id, provider_call_id, phone_e164, customer_id, lead_id, campaign_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, provider_call_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164,
       customer_id = COALESCE(EXCLUDED.customer_id, call_hints.customer_id), lead_id = COALESCE(EXCLUDED.lead_id, call_hints.lead_id),
       campaign_id = COALESCE(EXCLUDED.campaign_id, call_hints.campaign_id)`,
    [orgId, providerCallId, h.phone, h.customerId ?? null, h.leadId ?? null, h.campaignId ?? null]
  );
}

export async function hintFor(orgId: string, providerCallId: string): Promise<Hint | null> {
  const r = await one("SELECT phone_e164, customer_id, lead_id, campaign_id FROM call_hints WHERE org_id = $1 AND provider_call_id = $2", [orgId, providerCallId]);
  return r ? { phone: r.phone_e164, customerId: r.customer_id, leadId: r.lead_id, campaignId: r.campaign_id } : null;
}

/** Complete a stored call that has no number yet. Returns true when the call was updated. */
export async function applyHintToCall(orgId: string, providerCallId: string): Promise<boolean> {
  const h = await hintFor(orgId, providerCallId);
  if (!h) return false;
  const call = await one("SELECT id, phone_e164, customer_id, outcome, status, contact_purged FROM calls WHERE org_id = $1 AND provider_call_id = $2", [orgId, providerCallId]);
  if (!call || call.contact_purged || (call.phone_e164 && call.customer_id)) return false;
  const customerId = h.customerId || (await upsertCustomer(orgId, { phone: h.phone })).id;
  await q(
    `UPDATE calls SET phone_e164 = CASE WHEN phone_e164 = '' THEN $3 ELSE phone_e164 END, customer_id = COALESCE(customer_id, $4),
       lead_id = COALESCE(lead_id, $5), campaign_id = COALESCE(campaign_id, $6), updated_at = now()
     WHERE org_id = $1 AND provider_call_id = $2`,
    [orgId, providerCallId, h.phone, customerId, h.leadId, h.campaignId]
  );
  if (call.status === "ended" && call.outcome) await setStatusFromCall(customerId, call.outcome);
  await q("UPDATE customers SET updated_at = now() WHERE id = $1", [customerId]);
  return true;
}

/** Read a campaign's recipients from the provider and link every attempt's call to its number. */
export async function harvestCampaignHints(orgId: string, campaignId: string, recipients: any[]): Promise<number> {
  let linked = 0;
  for (const r of recipients) {
    const phone = String(r?.to_e164 || r?.contact_number || r?.phone_number || "");
    if (!phone) continue;
    const customer = await one("SELECT id FROM customers WHERE org_id = $1 AND phone_e164 = $2", [orgId, phone]);
    for (const at of Array.isArray(r?.attempts) ? r.attempts : []) {
      const callId = String(at?.call_session_id || at?.call_id || "");
      if (!callId) continue;
      if (await one("SELECT 1 AS x FROM calls WHERE org_id = $1 AND provider_call_id = $2 AND contact_purged", [orgId, callId])) continue;
      await rememberHint(orgId, callId, { phone, customerId: customer?.id ?? null, campaignId });
      if (await applyHintToCall(orgId, callId)) linked++;
    }
  }
  if (linked) log.info({ orgId, campaignId, linked }, "campaign calls linked to their contacts");
  return linked;
}
