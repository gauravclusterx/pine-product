/**
 * Outbound campaigns on the voice provider's campaign engine (create → plan → admit → start),
 * with the rules the provider does not apply: consent, our do-not-call list, and recipients
 * chosen from the client's own data by campaign kind.
 *
 * Each recipient carries their memory (name, profile, short history) so a campaign call is as
 * personal as a one-off call.
 */
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { toE164 } from "../lib/phone.js";
import * as rasen from "../voice/rasen/service.js";
import { mapRasenCampaignStatus } from "../voice/rasen/mappers.js";
import { getAgent } from "./agents.js";
import { buildCustomerMemory, toCustomer, upsertCustomer } from "./customers.js";
import type { Org } from "./orgs.js";
import { requireVoiceWorkspace } from "./voiceWorkspace.js";

export const CAMPAIGN_KINDS = ["estimate_followup", "membership_renewal", "reactivation", "after_job", "reminder", "custom"] as const;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(CAMPAIGN_KINDS).default("custom"),
  agentId: z.string().uuid(),
  /** For kind "custom": a CSV with a phone column (phone / contact_number) and any variables. */
  csv: z.string().max(5_000_000).optional(),
  /** For reactivation: customers whose last job is older than this. */
  inactiveMonths: z.number().int().min(1).max(60).default(12),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  maxAttemptsPerRecipient: z.number().int().min(1).max(5).default(2),
  /** Start now (default) or only create and plan it. */
  start: z.boolean().default(true),
});

interface Recipient { phone: string; customerId: string | null; variables: Record<string, string> }

/** Pick recipients from the client's data. Consent and DNC are applied afterwards for every kind. */
export async function selectRecipients(org: Org, input: z.infer<typeof createCampaignSchema>, now: Date = new Date()): Promise<Recipient[]> {
  let rows: any[] = [];
  switch (input.kind) {
    case "estimate_followup":
      rows = await q("SELECT * FROM customers WHERE org_id = $1 AND jsonb_array_length(COALESCE(crm_snapshot->'estimates', '[]'::jsonb)) > 0 LIMIT 20000", [org.id]);
      break;
    case "membership_renewal":
      rows = await q(
        "SELECT * FROM customers WHERE org_id = $1 AND crm_snapshot->'membership' IS NOT NULL AND (crm_snapshot->'membership'->>'expiresAt') IS NOT NULL AND (crm_snapshot->'membership'->>'expiresAt')::date <= ($2::date + 45) LIMIT 20000",
        [org.id, now]
      );
      break;
    case "reactivation":
      rows = await q(
        `SELECT c.* FROM customers c WHERE c.org_id = $1
           AND EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.starts_at > $2::timestamptz - ($3::int * interval '1 month'))
         LIMIT 20000`,
        [org.id, now, input.inactiveMonths]
      );
      break;
    case "after_job":
      rows = await q(
        `SELECT DISTINCT c.* FROM customers c JOIN bookings b ON b.customer_id = c.id
         WHERE c.org_id = $1 AND b.status IN ('booked','rescheduled','completed') AND b.ends_at BETWEEN $2::timestamptz - interval '2 days' AND $2::timestamptz LIMIT 20000`,
        [org.id, now]
      );
      break;
    case "reminder":
      rows = await q(
        `SELECT DISTINCT c.* FROM customers c JOIN bookings b ON b.customer_id = c.id
         WHERE c.org_id = $1 AND b.status IN ('booked','rescheduled') AND b.starts_at BETWEEN $2::timestamptz + interval '12 hours' AND $2::timestamptz + interval '36 hours' LIMIT 20000`,
        [org.id, now]
      );
      break;
    case "custom": {
      if (!input.csv) throw badRequest("Upload a CSV with a phone column.");
      const parsed: Record<string, string>[] = parseCsv(input.csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
      const out: Recipient[] = [];
      for (const r of parsed.slice(0, 20000)) {
        const phone = toE164(r.phone || r.contact_number || r.number || r.phone_number || "", org.settings.defaultCountryCode);
        if (!phone) continue;
        const name = r.name || r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" ");
        const consent = /^(yes|true|1|y)$/i.test(String(r.consent || ""));
        const c = await upsertCustomer(org.id, { phone, name, email: r.email, consentAt: consent ? now : null, consentSource: consent ? "csv" : null });
        const vars: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) if (/^[a-z][a-z0-9_]{0,40}$/.test(k) && v && !["phone", "contact_number", "number", "phone_number", "consent"].includes(k)) vars[k] = String(v).slice(0, 500);
        out.push({ phone, customerId: c.id, variables: vars });
      }
      return dedupe(out);
    }
  }
  return dedupe(rows.map((r) => ({ phone: r.phone_e164, customerId: r.id, variables: {} })));
}

function dedupe(list: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  return list.filter((r) => (seen.has(r.phone) ? false : (seen.add(r.phone), true)));
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function createCampaign(org: Org, userId: string | null, input: z.infer<typeof createCampaignSchema>, now: Date = new Date()) {
  const agent = await getAgent(org.id, input.agentId);
  if (agent.status !== "live" || !agent.providerAgentId) throw conflict("Publish the agent before using it in a campaign.");
  const all = await selectRecipients(org, input, now);
  // Rules the provider cannot know: our DNC list and the consent the law requires for automated calls.
  const dnc = new Set((await q("SELECT phone_e164 FROM dnc_list WHERE org_id = $1", [org.id])).map((r) => r.phone_e164));
  const consented = new Set(
    (await q("SELECT id FROM customers WHERE org_id = $1 AND consent_at IS NOT NULL AND id = ANY($2::uuid[])", [org.id, all.map((r) => r.customerId).filter(Boolean)])).map((r) => r.id)
  );
  const skipped = { do_not_call: 0, no_consent: 0 };
  const recipients = all.filter((r) => {
    if (dnc.has(r.phone)) { skipped.do_not_call++; return false; }
    if (org.settings.speedToLead.requireConsent && (!r.customerId || !consented.has(r.customerId))) { skipped.no_consent++; return false; }
    return true;
  });
  if (!recipients.length) throw badRequest(`Nobody to call: ${all.length} matched, ${skipped.do_not_call} on do-not-call, ${skipped.no_consent} without consent.`);

  const row = (await q(
    `INSERT INTO campaigns (org_id, name, kind, agent_id, status, calling_window, recipient_count, skipped, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8) RETURNING *`,
    [org.id, input.name, input.kind, agent.id, JSON.stringify({ timezone: org.timezone, opensMinute: org.settings.callingWindow.opens, closesMinute: org.settings.callingWindow.closes, startAt: input.startAt || null, endAt: input.endAt || null }),
      recipients.length, JSON.stringify(skipped), userId]
  ))[0];

  // One CSV row per recipient: their memory travels with them.
  const header = ["contact_number", "customer_id", "customer_name", "business_name", "profile", "context", "campaign_kind"];
  const extraKeys = Array.from(new Set(recipients.flatMap((r) => Object.keys(r.variables)))).filter((k) => !header.includes(k)).slice(0, 40);
  const lines = [[...header, ...extraKeys].join(",")];
  for (const r of recipients) {
    const cust = r.customerId ? await one("SELECT * FROM customers WHERE id = $1", [r.customerId]) : null;
    const mem = await buildCustomerMemory(org, cust ? toCustomer(cust) : null, now);
    const vals = [r.phone, r.customerId || "", cust?.name || "", org.name, mem.profile.slice(0, 800), mem.context.slice(0, 1500), input.kind, ...extraKeys.map((k) => r.variables[k] || "")];
    lines.push(vals.map((v) => csvCell(String(v))).join(","));
    await q("INSERT INTO campaign_recipients (campaign_id, org_id, phone_e164, customer_id, variables) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [row.id, org.id, r.phone, r.customerId, JSON.stringify(r.variables)]);
  }

  const ws = await requireVoiceWorkspace(org.id);
  try {
    const created = await rasen.createCampaignFromCsv(ws, agent.providerAgentId, Buffer.from(lines.join("\n"), "utf8"), `${input.name}.csv`, {
      fromNumber: org.settings.outboundNumber || null,
      maxAttemptsPerRecipient: input.maxAttemptsPerRecipient,
      timeZone: org.timezone,
      windowStartAt: input.startAt ? input.startAt.toISOString() : null,
      windowEndAt: input.endAt ? input.endAt.toISOString() : null,
      dailyOpensMinute: org.settings.callingWindow.opens,
      dailyClosesMinute: org.settings.callingWindow.closes,
      start: input.start,
    });
    const status = input.start ? "running" : "scheduled";
    return (await q("UPDATE campaigns SET provider_campaign_id = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *", [row.id, created.id, status]))[0];
  } catch (err) {
    const reason = rasen.describeRasenError(err);
    await q("UPDATE campaigns SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [row.id, reason.slice(0, 1000)]);
    throw badRequest(`The campaign could not be started: ${reason}`);
  }
}

export async function getCampaignRow(orgId: string, id: string) {
  const r = await one("SELECT * FROM campaigns WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw notFound("Campaign not found.");
  return r;
}

export async function campaignCommand(org: Org, id: string, command: "start" | "pause" | "resume" | "cancel") {
  const c = await getCampaignRow(org.id, id);
  if (!c.provider_campaign_id) throw badRequest("This campaign was never created at the voice provider.");
  const ws = await requireVoiceWorkspace(org.id);
  const r = command === "start" ? await rasen.startCampaign(ws, c.provider_campaign_id)
    : command === "pause" ? await rasen.pauseCampaign(ws, c.provider_campaign_id)
    : command === "resume" ? await rasen.resumeCampaign(ws, c.provider_campaign_id)
    : await rasen.cancelCampaign(ws, c.provider_campaign_id);
  const status = command === "cancel" ? "cancelled" : command === "pause" ? "paused" : "running";
  return (await q("UPDATE campaigns SET status = $3, progress = COALESCE($4, progress), updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *", [org.id, id, status, r?.progress ? JSON.stringify(r.progress) : null]))[0];
}

/** Refresh status and progress from the provider (poller). */
export async function syncCampaign(org: Org, id: string) {
  const c = await getCampaignRow(org.id, id);
  if (!c.provider_campaign_id || ["completed", "cancelled", "failed"].includes(c.status)) return c;
  const remote = await rasen.getCampaign(await requireVoiceWorkspace(org.id), c.provider_campaign_id);
  const mapped = mapRasenCampaignStatus(remote.status || remote.state);
  const status = mapped === "stopped" ? "cancelled" : ["draft", "scheduled", "running", "paused", "completed", "cancelled", "failed"].includes(mapped) ? mapped : c.status;
  return (await q("UPDATE campaigns SET status = $3, progress = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *", [org.id, id, status, JSON.stringify(remote.progress || remote.counts || {})]))[0];
}

export async function listCampaigns(orgId: string) {
  return q(
    `SELECT c.*, a.name AS agent_name,
       (SELECT count(*)::int FROM calls x WHERE x.campaign_id = c.id) AS calls,
       (SELECT count(*)::int FROM calls x WHERE x.campaign_id = c.id AND x.outcome = 'booked') AS booked
     FROM campaigns c JOIN agents a ON a.id = c.agent_id WHERE c.org_id = $1 ORDER BY c.created_at DESC`,
    [orgId]
  );
}
