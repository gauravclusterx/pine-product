/**
 * Placing outbound calls — every automated dial goes through `placeCall`, which applies the
 * rules in one place: do-not-call, consent, the calling window (client's local time), and the
 * provider's call-start limit (shared by every process). A rule that says "not now" defers the
 * job; a rule that says "never" ends it.
 */
import { one, q } from "../db/pool.js";
import { DeferJob, PermanentJobError, takeRateSlot } from "../queue/queue.js";
import { nextCallableTime } from "../lib/time.js";
import * as rasen from "../voice/rasen/service.js";
import { getAgent } from "./agents.js";
import { findCustomerByPhone, memoryVariables } from "./customers.js";
import type { Org } from "./orgs.js";
import { requireVoiceWorkspace } from "./voiceWorkspace.js";

/** Per voice-provider key: 10 call starts per minute (provider limit). */
export const CALL_STARTS_PER_MINUTE = 10;

export interface PlaceCallInput {
  agentId: string;
  phone: string;
  leadId?: string | null;
  campaignId?: string | null;
  /** Extra call variables (e.g. a lead's request). Memory variables are always added. */
  variables?: Record<string, string>;
  /** Makes a retried job replay the same call instead of dialling twice. */
  idempotencyKey: string;
  /** Skip the consent rule — only for calls a person starts by hand. */
  manual?: boolean;
  now?: Date;
}

export async function isOnDnc(orgId: string, phone: string): Promise<boolean> {
  return !!(await one("SELECT 1 AS x FROM dnc_list WHERE org_id = $1 AND phone_e164 = $2", [orgId, phone]));
}

/** Throws DeferJob / PermanentJobError for the queue; returns the provider call id on success. */
export async function placeCall(org: Org, input: PlaceCallInput): Promise<{ providerCallId: string }> {
  const now = input.now ?? new Date();
  if (org.status !== "active") throw new PermanentJobError("workspace is not active");
  if (await isOnDnc(org.id, input.phone)) throw new PermanentJobError("number is on the do-not-call list");
  const customer = await findCustomerByPhone(org.id, input.phone);
  if (!input.manual && org.settings.speedToLead.requireConsent && !customer?.consentAt) {
    throw new PermanentJobError("no consent to call this number on record");
  }
  const w = org.settings.callingWindow;
  const when = nextCallableTime(now, org.timezone, w.opens, w.closes);
  if (when.getTime() > now.getTime()) throw new DeferJob(when.getTime() - now.getTime(), "outside the calling window");

  const agent = await getAgent(org.id, input.agentId);
  if (agent.status !== "live" || !agent.providerAgentId) throw new PermanentJobError(`agent "${agent.name}" is not live`);
  const ws = await requireVoiceWorkspace(org.id);
  const wait = await takeRateSlot(`calls:${ws.workspaceId}`, CALL_STARTS_PER_MINUTE);
  if (wait > 0) throw new DeferJob(wait, "call-start limit");

  const memory = await memoryVariables(org, customer);
  try {
    const call = await rasen.createOutboundCall(ws, {
      agentId: agent.providerAgentId,
      customerNumber: input.phone,
      fromNumber: org.settings.outboundNumber || null,
      customerName: customer?.name || undefined,
      variableValues: { ...memory, ...(input.variables || {}) },
      metadata: { org_id: org.id, lead_id: input.leadId || "", campaign_id: input.campaignId || "", source: input.campaignId ? "campaign" : input.leadId ? "speed_to_lead" : "manual" },
      idempotencyKey: input.idempotencyKey,
    });
    await q(
      `INSERT INTO calls (org_id, provider_call_id, agent_id, direction, customer_id, lead_id, campaign_id, phone_e164, status, started_at)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, 'queued', now()) ON CONFLICT (org_id, provider_call_id) DO NOTHING`,
      [org.id, call.id, agent.id, customer?.id || null, input.leadId || null, input.campaignId || null, input.phone]
    );
    return { providerCallId: call.id };
  } catch (err) {
    if (rasen.isRasenBackpressure(err)) throw new DeferJob(30_000, "provider asked us to slow down");
    const status = (err as any)?.status;
    if (status && status >= 400 && status < 500 && status !== 409 && status !== 429) throw new PermanentJobError(rasen.describeRasenError(err));
    throw err;
  }
}
