/**
 * Lead intake. Every source (Google LSA, Meta, Yelp, Angi, Thumbtack, website forms, chat, lead
 * emails, the API) is normalised to one shape and goes through `acceptLead`:
 *
 *   1. dedupe on (org, source, source id) — a redelivered webhook never makes a second call
 *   2. the client's rules: service area, do-not-call
 *   3. save the customer (with consent, when the source carries it) and the lead
 *   4. queue the speed-to-lead call in the SAME transaction, so a saved lead is always called
 *
 * The call job then waits for the calling window and the provider's rate limit if it must.
 */
import { z } from "zod";
import { one, q, tx } from "../db/pool.js";
import { toE164 } from "../lib/phone.js";
import { enqueue } from "../queue/queue.js";
import { leadAgentFor, servesPostalCode, type Org } from "../modules/orgs.js";
import { upsertCustomer } from "../modules/customers.js";

export const LEAD_SOURCES = ["google_lsa", "meta", "yelp", "angi", "thumbtack", "web_form", "web_chat", "email", "manual", "api", "phone"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const leadInputSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  sourceRef: z.string().trim().min(1).max(200),
  name: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.string().trim().max(200).default(""),
  service: z.string().trim().max(120).default(""),
  postalCode: z.string().trim().max(12).default(""),
  street: z.string().trim().max(200).default(""),
  city: z.string().trim().max(100).default(""),
  state: z.string().trim().max(50).default(""),
  message: z.string().max(4000).default(""),
  /** The person agreed to be contacted by phone (form checkbox, platform terms). */
  consent: z.boolean().default(false),
  receivedAt: z.coerce.date().optional(),
  payload: z.record(z.string(), z.any()).default({}),
});
export type LeadInput = z.input<typeof leadInputSchema>;

export interface AcceptResult { leadId: string; duplicate: boolean; status: string; rejectReason: string | null; callQueued: boolean }

export async function acceptLead(org: Org, raw: LeadInput): Promise<AcceptResult> {
  const input = leadInputSchema.parse(raw);
  const existing = await one("SELECT id, status, reject_reason FROM leads WHERE org_id = $1 AND source = $2 AND source_ref = $3", [org.id, input.source, input.sourceRef]);
  if (existing) return { leadId: existing.id, duplicate: true, status: existing.status, rejectReason: existing.reject_reason, callQueued: false };

  const phone = toE164(input.phone, org.settings.defaultCountryCode);
  let rejectReason: string | null = null;
  if (!phone) rejectReason = "no valid phone number";
  else if (input.postalCode && !servesPostalCode(org.settings, input.postalCode)) rejectReason = `outside the service area (${input.postalCode})`;
  else if (await one("SELECT 1 AS x FROM dnc_list WHERE org_id = $1 AND phone_e164 = $2", [org.id, phone])) rejectReason = "number is on the do-not-call list";

  const stl = org.settings.speedToLead;
  const willCall = !rejectReason && stl.enabled && !!leadAgentFor(org.settings, input.source) && (input.consent || !stl.requireConsent);
  return tx(async (t) => {
    const customer = phone
      ? await upsertCustomer(org.id, {
          phone, name: input.name, email: input.email,
          address: { street: input.street, city: input.city, state: input.state, postalCode: input.postalCode },
          consentAt: input.consent ? input.receivedAt || new Date() : null, consentSource: input.consent ? input.source : null,
        }, t)
      : null;
    const rows = await t(
      `INSERT INTO leads (org_id, source, source_ref, customer_id, name, phone_e164, email, service, postal_code, message, payload, status, reject_reason, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (org_id, source, source_ref) DO NOTHING RETURNING id`,
      [org.id, input.source, input.sourceRef, customer?.id || null, input.name, phone, input.email, input.service, input.postalCode, input.message.slice(0, 4000),
        JSON.stringify(input.payload), rejectReason ? "rejected" : willCall ? "queued" : "new", rejectReason, input.receivedAt || new Date()]
    );
    // Lost the race with a concurrent delivery of the same lead.
    if (!rows[0]) {
      const again = (await t("SELECT id, status, reject_reason FROM leads WHERE org_id = $1 AND source = $2 AND source_ref = $3", [org.id, input.source, input.sourceRef]))[0];
      return { leadId: again.id, duplicate: true, status: again.status, rejectReason: again.reject_reason, callQueued: false };
    }
    const leadId = rows[0].id;
    if (willCall) await enqueue("lead.call", { leadId }, { orgId: org.id, dedupeKey: `lead-call:${leadId}:0`, q: t, maxAttempts: 20 });
    await t("INSERT INTO audit_log (org_id, action, detail) VALUES ($1, 'lead.received', $2)", [org.id, JSON.stringify({ leadId, source: input.source, rejected: rejectReason })]);
    return { leadId, duplicate: false, status: rejectReason ? "rejected" : willCall ? "queued" : "new", rejectReason, callQueued: willCall };
  });
}

/** Variables a speed-to-lead call carries, so the agent opens with what the person asked for. */
export function leadVariables(lead: any): Record<string, string> {
  return {
    lead_source: String(lead.source || "").replace(/_/g, " "),
    lead_service: String(lead.service || ""),
    lead_message: String(lead.message || "").slice(0, 500),
  };
}

export async function getLeadRow(orgId: string, id: string) {
  return one("SELECT * FROM leads WHERE org_id = $1 AND id = $2", [orgId, id]);
}

export async function listLeads(orgId: string, f: { status?: string; source?: string }, limit: number, offset: number) {
  const where = ["l.org_id = $1"];
  const params: unknown[] = [orgId];
  if (f.status) { params.push(f.status); where.push(`l.status = $${params.length}`); }
  if (f.source) { params.push(f.source); where.push(`l.source = $${params.length}`); }
  params.push(limit, offset);
  return q(
    `SELECT l.id, l.source, l.name, l.phone_e164, l.service, l.postal_code, l.status, l.reject_reason, l.received_at, l.first_call_at, l.attempts,
            EXTRACT(EPOCH FROM (l.first_call_at - l.received_at))::int AS seconds_to_call
     FROM leads l WHERE ${where.join(" AND ")} ORDER BY l.received_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}
