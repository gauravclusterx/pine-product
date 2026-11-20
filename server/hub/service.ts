/**
 * The standard tools — identical for every client, whatever software they run.
 *
 *   lookup_customer   before the call: who is calling (name on file, history → agent memory)
 *   get_availability  open arrival windows for a day / job type / area
 *   book_job          create customer (if new) + job + appointment, confirm by SMS, alert the team
 *   reschedule_job    move the customer's next appointment
 *   cancel_job        cancel the customer's next appointment
 *   create_lead       save a caller who did not book
 *   get_estimates     open estimates (follow-up calls)
 *   get_membership    membership status (renewal calls)
 *   send_sms          text the caller a confirmation, address or link
 *   notify_team       alert the office (emergency, unhappy customer…)
 *
 * Every answer is a short sentence the agent can act on. Times are worked out here, in the
 * client's time zone, never by the language model.
 */
import { one, q, tx } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { toE164 } from "../lib/phone.js";
import { normaliseSpokenNumbers, timeOf } from "../lib/spoken.js";
import { speakTime, zonedParts, zonedTimeToUtc } from "../lib/time.js";
import type { Org } from "../modules/orgs.js";
import { findCustomerByPhone, memoryVariables, upsertCustomer, type Customer } from "../modules/customers.js";
import { connectorContext, markIntegration } from "./registry.js";
import { notifyTeam, sendSms, type AlertKind } from "./notify.js";
import { candidateSlots, parseSlotStart, resolveDayRange, slotLabel } from "./slots.js";
import { ConnectorError, type HttpFn, type Slot } from "./types.js";
import { fetchHttp } from "./http.js";

export const STANDARD_TOOLS = [
  "lookup_customer", "get_availability", "book_job", "reschedule_job", "cancel_job",
  "create_lead", "get_estimates", "get_membership", "send_sms", "notify_team",
] as const;
export type ToolName = (typeof STANDARD_TOOLS)[number];

export interface ToolMeta {
  /** The provider's agent id (from the tool's constant parameter). */
  providerAgentId?: string;
  providerCallId?: string;
}

export interface ToolResult { result: string; data?: Record<string, unknown> }

export interface ToolDeps { http?: HttpFn; now?: Date }

const MAX_OFFERED = 6;

function jobTypeOf(org: Org, raw: unknown): { name: string; durationMinutes: number; valueCents: number } {
  const want = String(raw || "").trim().toLowerCase();
  const services = org.settings.services;
  const hit = services.find((s) => s.name.toLowerCase() === want) || services.find((s) => want && (s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase())));
  if (hit) return hit;
  return { name: String(raw || "").trim().slice(0, 80) || "Service visit", durationMinutes: org.settings.slotMinutes, valueCents: 0 };
}

/** Who is on the line: the dialled number (outbound) or the caller recorded by lookup (inbound). */
async function callerPhone(org: Org, args: Record<string, any>, meta: ToolMeta): Promise<string> {
  const cc = org.settings.defaultCountryCode;
  const direct = toE164(args.customer_phone || args.phone || "", cc);
  if (direct) return direct;
  if (!meta.providerAgentId) return "";
  // Only when exactly one caller reached this agent recently, so two simultaneous inbound calls
  // can never be mixed up.
  const rows = await q(
    "SELECT DISTINCT phone_e164 FROM inbound_lookups WHERE org_id = $1 AND provider_agent_id = $2 AND created_at > now() - interval '45 minutes' LIMIT 2",
    [org.id, meta.providerAgentId]
  );
  return rows.length === 1 ? rows[0].phone_e164 : "";
}

/** Open windows: the connector's own capacity when it has one, else hours minus our bookings. */
export async function openSlots(org: Org, from: Date, to: Date, jobType: string, postalCode: string, deps: ToolDeps = {}): Promise<Slot[]> {
  const now = deps.now ?? new Date();
  const { connector, ctx } = await connectorContext(org, org.settings.crm, deps.http ?? fetchHttp);
  const job = jobTypeOf(org, jobType);
  let slots: Slot[] | null = null;
  if (org.settings.crm !== "native") {
    try {
      slots = await connector.getAvailability(ctx, { from, to, jobType: job.name, postalCode, durationMinutes: job.durationMinutes });
    } catch (err) {
      await markIntegration(org.id, org.settings.crm, false, (err as Error).message);
      throw err;
    }
  }
  if (slots) return slots.filter((s) => s.start.getTime() > now.getTime() + 30 * 60_000).sort((a, b) => a.start.getTime() - b.start.getTime());
  const candidates = candidateSlots(org, from, to, { now });
  if (!candidates.length) return [];
  const taken = await q(
    "SELECT starts_at, count(*)::int AS n FROM bookings WHERE org_id = $1 AND status IN ('booked','rescheduled') AND starts_at >= $2 AND starts_at < $3 GROUP BY starts_at",
    [org.id, candidates[0].start, candidates[candidates.length - 1].end]
  );
  const count = new Map(taken.map((t) => [new Date(t.starts_at).getTime(), t.n]));
  return candidates.filter((s) => (count.get(s.start.getTime()) || 0) < org.settings.slotCapacity);
}

function describeSlots(org: Org, slots: Slot[]): { text: string; offered: Array<{ start: string; label: string }> } {
  const offered = slots.slice(0, MAX_OFFERED).map((s) => ({ start: s.start.toISOString(), label: slotLabel(s, org.timezone) }));
  return { text: offered.map((o) => `${o.label} [start=${o.start}]`).join("; "), offered };
}

/**
 * The instant the customer agreed to. Agents are asked to pass the `start` of an offered slot;
 * a spoken day + time ("Saturday 5 PM", "twenty-first of November at five") is accepted too.
 */
export function resolveRequestedStart(org: Org, raw: unknown, now: Date = new Date()): Date | null {
  const exact = parseSlotStart(raw);
  if (exact) return exact;
  const text = normaliseSpokenNumbers(String(raw ?? ""));
  const day = resolveDayRange(text, org.timezone, now);
  const time = timeOf(text);
  if (!day || !time) return null;
  const p = zonedParts(new Date(day.from.getTime() + 12 * 3_600_000), org.timezone);
  return zonedTimeToUtc(p.year, p.month, p.day, time.hour, time.minute, org.timezone);
}

async function nextBooking(org: Org, customer: Customer | null): Promise<any | null> {
  if (!customer) return null;
  return one("SELECT * FROM bookings WHERE org_id = $1 AND customer_id = $2 AND status IN ('booked','rescheduled') AND starts_at > now() ORDER BY starts_at LIMIT 1", [org.id, customer.id]);
}

export async function runTool(org: Org, name: string, args: Record<string, any>, meta: ToolMeta = {}, deps: ToolDeps = {}): Promise<ToolResult> {
  const http = deps.http ?? fetchHttp;
  const now = deps.now ?? new Date();
  const tz = org.timezone;
  try {
    switch (name as ToolName) {
      case "lookup_customer": {
        const phone = toE164(args.phone || args.caller_id || "", org.settings.defaultCountryCode);
        if (!phone) return { result: "Unknown caller.", data: { known: false } };
        if (meta.providerAgentId) {
          await q("INSERT INTO inbound_lookups (org_id, provider_agent_id, phone_e164, provider_call_id) VALUES ($1, $2, $3, $4)", [org.id, meta.providerAgentId, phone, meta.providerCallId || null]);
        }
        let customer = await findCustomerByPhone(org.id, phone);
        if (org.settings.crm !== "native") {
          // The client's system is the source of truth for who this is. Bounded: a slow CRM must
          // not delay the greeting — the before-call tool has about four seconds.
          try {
            const { connector, ctx } = await connectorContext(org, org.settings.crm, http);
            const ext = await Promise.race([connector.lookupCustomer(ctx, phone), new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
            if (ext) {
              customer = await upsertCustomer(org.id, { phone, name: ext.name, email: ext.email, address: ext.address as any, externalId: ext.externalId, connector: org.settings.crm, notes: ext.notes });
            }
          } catch (err) {
            log.warn({ orgId: org.id, err: (err as Error).message }, "crm lookup failed");
          }
        }
        const vars = await memoryVariables(org, customer);
        return {
          result: customer?.name ? `Known customer: ${customer.name}.` : "New caller.",
          data: { known: !!customer, name: customer?.name || "", profile: vars.profile, context: vars.context },
        };
      }

      case "get_availability": {
        const job = jobTypeOf(org, args.job_type);
        const range = resolveDayRange(args.day, tz, now);
        const from = range?.from ?? now;
        const to = range?.to ?? new Date(now.getTime() + org.settings.bookingHorizonDays * 86_400_000);
        const postal = String(args.postal_code || "").trim();
        if (postal && org.settings.serviceAreas.length) {
          const { servesPostalCode } = await import("../modules/orgs.js");
          if (!servesPostalCode(org.settings, postal)) {
            return { result: `We do not serve postal code ${postal}. Apologise, and offer to take a message for the office.`, data: { served: false } };
          }
        }
        let slots = await openSlots(org, from, to, job.name, postal, deps);
        if (!slots.length && range) {
          // Nothing that day: offer the nearest days instead of a dead end.
          slots = await openSlots(org, range.to, new Date(range.to.getTime() + 7 * 86_400_000), job.name, postal, deps);
          if (!slots.length) return { result: "No openings in the next week. Offer to have the office call back with a time.", data: { slots: [] } };
          const d = describeSlots(org, slots);
          return { result: `Nothing is open that day. The nearest openings: ${d.text}. Offer two or three of these, by day and time.`, data: { slots: d.offered } };
        }
        if (!slots.length) return { result: "No openings in the booking window. Offer to have the office call back.", data: { slots: [] } };
        const d = describeSlots(org, slots);
        return { result: `Open arrival windows for ${job.name}: ${d.text}. Offer two or three by day and time; when the customer picks one, call book_job with its start value.`, data: { slots: d.offered } };
      }

      case "book_job": {
        const start = resolveRequestedStart(org, args.start ?? args.date_time, now);
        if (!start) return { result: "The time could not be read. Ask for the day and the time together (e.g. 'Saturday 5 PM'), or offer the windows from get_availability." };
        const phone = await callerPhone(org, args, meta);
        if (!phone) return { result: "I do not have the customer's phone number. Ask for it, then book again with customer_phone." };
        const job = jobTypeOf(org, args.job_type);
        // A retried tool call (the provider retries on timeouts) must not book twice, and must not
        // be told "taken" by its own first booking — so look for it before checking the window.
        const prior = await one(
          "SELECT * FROM bookings WHERE org_id = $1 AND idempotency_key LIKE $2 AND starts_at <= $3 AND ends_at > $3 AND status IN ('booked','rescheduled')",
          [org.id, `${(meta.providerCallId || phone).replace(/[%_\\]/g, "\\$&")}:%`, start]
        );
        if (prior) return { result: `Already booked for ${slotLabel({ start: new Date(prior.starts_at), end: new Date(prior.ends_at) }, tz)}. Confirm it to the customer.`, data: { booked: true, bookingId: prior.id } };
        // The window must be one we would offer right now.
        const dayStart = new Date(start.getTime() - 24 * 3_600_000);
        const open = await openSlots(org, dayStart, new Date(start.getTime() + 24 * 3_600_000), job.name, String(args.postal_code || ""), deps);
        const slot = open.find((s) => s.start.getTime() <= start.getTime() && start.getTime() < s.end.getTime());
        if (!slot) {
          const alt = describeSlots(org, open.filter((s) => s.start > now));
          return { result: `${speakTime(start, tz)} is not available.${alt.offered.length ? ` Open instead: ${alt.text}.` : " Offer another day."}`, data: { booked: false, slots: alt.offered } };
        }
        let customer = await findCustomerByPhone(org.id, phone);
        const address = { street: args.street || customer?.address?.street, city: args.city || customer?.address?.city, state: args.state || customer?.address?.state, postalCode: args.postal_code || customer?.address?.postalCode };
        customer = await upsertCustomer(org.id, { phone, name: String(args.customer_name || "").trim(), address });
        const idem = `${meta.providerCallId || phone}:${slot.start.toISOString()}`;
        const existing = await one("SELECT * FROM bookings WHERE org_id = $1 AND idempotency_key = $2", [org.id, idem]);
        if (existing) return { result: `Already booked for ${slotLabel(slot, tz)}. Confirm it to the customer.`, data: { booked: true, bookingId: existing.id } };

        let externalJobId = "";
        if (org.settings.crm !== "native") {
          const { connector, ctx } = await connectorContext(org, org.settings.crm, http);
          const r = await connector.bookJob(ctx, {
            externalCustomerId: customer.connector === org.settings.crm ? customer.externalId : null,
            customer: { name: customer.name || String(args.customer_name || ""), phone, email: customer.email || undefined, address },
            jobType: job.name, start: slot.start, end: slot.end, notes: String(args.notes || "").slice(0, 2000), source: "Pine AI", idempotencyKey: idem,
          });
          externalJobId = r.externalJobId;
          if (r.externalCustomerId && !customer.externalId) {
            await q("UPDATE customers SET external_id = $3, connector = $4, updated_at = now() WHERE org_id = $1 AND id = $2", [org.id, customer.id, r.externalCustomerId, org.settings.crm]);
          }
          await markIntegration(org.id, org.settings.crm, true);
        }
        const call = meta.providerCallId ? await one("SELECT id, lead_id FROM calls WHERE org_id = $1 AND provider_call_id = $2", [org.id, meta.providerCallId]) : null;
        const lead = call?.lead_id ? { id: call.lead_id } : await one("SELECT id FROM leads WHERE org_id = $1 AND customer_id = $2 AND status IN ('new','queued','calling','contacted') ORDER BY received_at DESC LIMIT 1", [org.id, customer.id]);
        const booking = await tx(async (t) => {
          // Capacity is checked and taken atomically, so two calls cannot both get the last place.
          await t("SELECT pg_advisory_xact_lock(hashtext($1))", [`${org.id}:${slot.start.toISOString()}`]);
          if (org.settings.crm === "native") {
            const n = (await t("SELECT count(*)::int AS n FROM bookings WHERE org_id = $1 AND starts_at = $2 AND status IN ('booked','rescheduled')", [org.id, slot.start]))[0].n;
            if (n >= org.settings.slotCapacity) return null;
          }
          const rows = await t(
            `INSERT INTO bookings (org_id, call_id, customer_id, lead_id, connector, external_job_id, job_type, starts_at, ends_at, value_cents, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING *`,
            [org.id, call?.id || null, customer!.id, lead?.id || null, org.settings.crm, externalJobId || null, job.name, slot.start, slot.end, job.valueCents, idem]
          );
          if (lead?.id) await t("UPDATE leads SET status = 'booked', updated_at = now() WHERE id = $1", [lead.id]);
          return rows[0] || null;
        });
        if (!booking) {
          const alt = describeSlots(org, (await openSlots(org, now, new Date(start.getTime() + 3 * 86_400_000), job.name, "", deps)));
          return { result: `That window was just taken.${alt.offered.length ? ` Open instead: ${alt.text}.` : ""}`, data: { booked: false } };
        }
        const label = slotLabel(slot, tz);
        sendSms(org.id, phone, `${org.name}: your ${job.name} visit is booked for ${label}. Reply to this message to change it.`, http).catch(() => {});
        notifyTeam(org.id, "new_booking", `New booking: ${customer.name || phone} — ${job.name}, ${label}.`, http).catch(() => {});
        return { result: `Booked: ${job.name}, ${label}. Confirm the day and arrival window to the customer; a text confirmation is on its way.`, data: { booked: true, bookingId: booking.id } };
      }

      case "reschedule_job": {
        const phone = await callerPhone(org, args, meta);
        const customer = phone ? await findCustomerByPhone(org.id, phone) : null;
        const b = await nextBooking(org, customer);
        if (!b) return { result: "No upcoming appointment was found for this customer." };
        const start = resolveRequestedStart(org, args.start ?? args.date_time, now);
        if (!start) return { result: "The new time could not be read. Ask for the day and time together." };
        const open = await openSlots(org, new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 86_400_000), b.job_type, "", deps);
        const slot = open.find((s) => s.start.getTime() <= start.getTime() && start.getTime() < s.end.getTime());
        if (!slot) return { result: `${speakTime(start, tz)} is not available. ${describeSlots(org, open.filter((s) => s.start > now)).text}` };
        if (b.connector !== "native" && b.external_job_id) {
          const { connector, ctx } = await connectorContext(org, b.connector, http);
          await connector.reschedule(ctx, { externalJobId: b.external_job_id, start: slot.start, end: slot.end });
        }
        await q("UPDATE bookings SET starts_at = $3, ends_at = $4, status = 'rescheduled', updated_at = now() WHERE org_id = $1 AND id = $2", [org.id, b.id, slot.start, slot.end]);
        sendSms(org.id, phone, `${org.name}: your appointment moved to ${slotLabel(slot, tz)}.`, http).catch(() => {});
        return { result: `Moved to ${slotLabel(slot, tz)}. Confirm it to the customer.` };
      }

      case "cancel_job": {
        const phone = await callerPhone(org, args, meta);
        const customer = phone ? await findCustomerByPhone(org.id, phone) : null;
        const b = await nextBooking(org, customer);
        if (!b) return { result: "No upcoming appointment was found for this customer." };
        if (b.connector !== "native" && b.external_job_id) {
          const { connector, ctx } = await connectorContext(org, b.connector, http);
          try {
            await connector.cancel(ctx, { externalJobId: b.external_job_id, reason: String(args.reason || "") });
          } catch (err) {
            if (!(err instanceof ConnectorError)) throw err;
            await notifyTeam(org.id, "info", `Please cancel in ${b.connector}: ${customer?.name || phone}, ${speakTime(new Date(b.starts_at), tz)}. ${err.message}`, http);
          }
        }
        await q("UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE org_id = $1 AND id = $2", [org.id, b.id]);
        notifyTeam(org.id, "info", `Cancelled by phone: ${customer?.name || phone}, ${speakTime(new Date(b.starts_at), tz)}${args.reason ? ` (${args.reason})` : ""}.`, http).catch(() => {});
        return { result: `Cancelled the appointment on ${speakTime(new Date(b.starts_at), tz)}. Confirm to the customer and offer to rebook later.` };
      }

      case "create_lead": {
        const phone = await callerPhone(org, args, meta);
        if (!phone) return { result: "Ask for the customer's phone number first." };
        const customer = await upsertCustomer(org.id, { phone, name: String(args.customer_name || "") });
        const summary = String(args.summary || args.notes || "Caller did not book").slice(0, 2000);
        const ref = meta.providerCallId || `${phone}:${now.toISOString().slice(0, 13)}`;
        await q(
          `INSERT INTO leads (org_id, source, source_ref, customer_id, name, phone_e164, service, message, status)
           VALUES ($1, 'phone', $2, $3, $4, $5, $6, $7, 'contacted') ON CONFLICT (org_id, source, source_ref) DO UPDATE SET message = EXCLUDED.message, updated_at = now()`,
          [org.id, ref, customer.id, customer.name, phone, String(args.service || ""), summary]
        );
        if (org.settings.crm !== "native") {
          const { connector, ctx } = await connectorContext(org, org.settings.crm, http);
          await connector.createLead(ctx, { customer: { name: customer.name, phone, email: customer.email || undefined }, summary, source: "Pine AI" }).catch((e) => log.warn({ err: e.message }, "crm createLead failed"));
        }
        return { result: "Saved. Tell the customer the office will follow up." };
      }

      case "get_estimates":
      case "get_membership": {
        const phone = await callerPhone(org, args, meta);
        const customer = phone ? await findCustomerByPhone(org.id, phone) : null;
        if (!customer?.externalId || org.settings.crm === "native") return { result: name === "get_estimates" ? "No open estimates on file." : "No membership on file." };
        const { connector, ctx } = await connectorContext(org, org.settings.crm, http);
        if (name === "get_estimates") {
          const est = await connector.getEstimates(ctx, customer.externalId);
          await q("UPDATE customers SET crm_snapshot = crm_snapshot || $3, updated_at = now() WHERE org_id = $1 AND id = $2", [org.id, customer.id, JSON.stringify({ estimates: est, estimatesAt: now.toISOString() })]);
          return est.length
            ? { result: `Open estimates: ${est.map((e) => `${e.title} — $${(e.amountCents / 100).toFixed(0)}`).join("; ")}.`, data: { estimates: est } }
            : { result: "No open estimates on file." };
        }
        const m = await connector.getMembership(ctx, customer.externalId);
        await q("UPDATE customers SET crm_snapshot = crm_snapshot || $3, updated_at = now() WHERE org_id = $1 AND id = $2", [org.id, customer.id, JSON.stringify({ membership: m, membershipAt: now.toISOString() })]);
        return m ? { result: `Membership: ${m.name}, ${m.status}${m.expiresAt ? `, ends ${String(m.expiresAt).slice(0, 10)}` : ""}.`, data: { membership: m } } : { result: "No membership on file." };
      }

      case "send_sms": {
        const phone = await callerPhone(org, args, meta);
        const text = String(args.message || "").trim();
        if (!phone || !text) return { result: "Nothing was sent: a phone number and a message are both needed." };
        const r = await sendSms(org.id, phone, `${org.name}: ${text}`.slice(0, 600), http);
        return { result: r.sent ? "The text was sent." : `The text could not be sent (${r.detail}). Read the details out instead.` };
      }

      case "notify_team": {
        const kinds: AlertKind[] = ["emergency", "unhappy_customer", "lost_lead", "info"];
        const kind = (kinds.includes(args.kind) ? args.kind : "info") as AlertKind;
        const phone = await callerPhone(org, args, meta);
        const r = await notifyTeam(org.id, kind, `${String(args.message || "").slice(0, 1000)}${phone ? ` — caller ${phone}` : ""}`, http);
        return { result: r.some((x) => x.sent) || !r.length ? "The team has been told." : "The alert is saved for the team." };
      }

      default:
        return { result: `Unknown tool "${name}".` };
    }
  } catch (err) {
    log.warn({ orgId: org.id, tool: name, err: (err as Error).message }, "tool failed");
    if (err instanceof ConnectorError) {
      return { result: `The schedule system did not answer properly. Do not promise a time; offer to have the office confirm by phone or text.` };
    }
    return { result: "Something went wrong on our side. Do not promise anything; offer to have the office follow up." };
  }
}
