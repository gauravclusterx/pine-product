/**
 * Booking capture — the CRM's bookingCapture for calls: when a call ends and the conversation shows
 * a booking was agreed (or moved, or called off) but the agent's book_job tool did not record one,
 * the transcript is read with the admin-set AI key and the Booking is created, rescheduled or
 * cancelled, so it shows on the Bookings page and on the contact. One booking per call (idempotent).
 */
import { one, q } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { localDate, speakTime, zonedTimeToUtc } from "../lib/time.js";
import { aiAvailable, chatFor, type ChatFn } from "./ai.js";
import { getOrg } from "./orgs.js";
import { setStatusFromCall } from "./customers.js";

const SIGNALS = /\b(book|booked|booking|appointment|schedule|slot|visit|technician|meeting|confirm|confirmed|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d\s*(?:am|pm)|o'?clock|reschedul|cancel|postpon|move)\b/i;

const SYSTEM = (today: string, services: string) => `Today is ${today}. You read a phone call between a business's agent and a customer and decide what happened to a service appointment. Output STRICT JSON only:
{"action": "book" | "reschedule" | "cancel" | "none",
 "service": the service booked (match one of: ${services || "any"}), or "",
 "dateISO": the (new) appointment date as YYYY-MM-DD (work it out from "tomorrow", weekdays etc.), or "",
 "time": the (new) start time as HH:MM 24-hour, or "",
 "address": service address if given, or "",
 "notes": any extra detail, or ""}
"book" only when the customer agreed a specific appointment (not just asked). When an appointment was changed during the call, give the final agreed date/time.`;

export function parseCapture(text: string): { action: string; service: string; dateISO: string; time: string; address: string; notes: string } | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    if (!["book", "reschedule", "cancel", "none"].includes(j.action)) return null;
    const dateISO = /^\d{4}-\d{2}-\d{2}$/.test(String(j.dateISO || "")) ? String(j.dateISO) : "";
    const time = /^\d{1,2}:\d{2}$/.test(String(j.time || "")) ? String(j.time) : "";
    return { action: j.action, service: String(j.service || "").slice(0, 80), dateISO, time, address: String(j.address || "").slice(0, 300), notes: String(j.notes || "").slice(0, 500) };
  } catch { return null; }
}

export async function captureBookingFromCall(callId: string, chat?: ChatFn): Promise<"booked" | "rescheduled" | "cancelled" | "none" | "skipped"> {
  const c = await one("SELECT id, org_id, customer_id, lead_id, transcript, status FROM calls WHERE id = $1", [callId]);
  if (!c || c.status !== "ended" || !c.customer_id) return "skipped";
  const lines: string[] = Array.isArray(c.transcript) ? c.transcript : [];
  const text = lines.join("\n");
  if (lines.length < 2 || !SIGNALS.test(text)) return "skipped";
  if (await one("SELECT 1 AS x FROM bookings WHERE org_id = $1 AND call_id = $2", [c.org_id, c.id])) return "skipped"; // the tool already booked
  if (!(await aiAvailable(c.org_id))) return "skipped";
  const org = await getOrg(c.org_id);
  const services = org.settings.services || [];
  let r;
  try {
    r = await chatFor(org.id, { system: SYSTEM(`${speakTime(new Date(), org.timezone)} (${localDate(new Date(), org.timezone)}, ${org.timezone})`, services.map((s) => s.name).join(", ")), messages: [{ role: "user", content: text.slice(0, 20_000) }], maxTokens: 1500 }, chat);
  } catch (err) {
    log.warn({ callId, err: (err as Error).message }, "booking capture: AI failed");
    return "skipped";
  }
  const cap = parseCapture(r.text);
  if (!cap || cap.action === "none") return "none";

  const latest = await one("SELECT id FROM bookings WHERE org_id = $1 AND customer_id = $2 AND status IN ('booked','rescheduled') AND starts_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1", [org.id, c.customer_id]);
  if (cap.action === "cancel") {
    if (!latest) return "none";
    await q("UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1", [latest.id]);
    return "cancelled";
  }
  if (!cap.dateISO) return "none";
  const [y, mo, d] = cap.dateISO.split("-").map(Number);
  const [hh, mm] = (cap.time || "10:00").split(":").map(Number);
  const start = zonedTimeToUtc(y, mo, d, hh, mm, org.timezone);
  const svc = services.find((s) => s.name.toLowerCase() === cap.service.toLowerCase()) || services.find((s) => cap.service && s.name.toLowerCase().includes(cap.service.toLowerCase()));
  const minutes = svc?.durationMinutes || org.settings.slotMinutes || 120;
  const end = new Date(start.getTime() + minutes * 60_000);

  if (cap.action === "reschedule" && latest) {
    await q("UPDATE bookings SET starts_at = $2, ends_at = $3, status = 'rescheduled', updated_at = now() WHERE id = $1", [latest.id, start, end]);
    return "rescheduled";
  }
  const inserted = await one(
    `INSERT INTO bookings (org_id, call_id, customer_id, lead_id, connector, job_type, starts_at, ends_at, value_cents, idempotency_key)
     VALUES ($1, $2, $3, $4, 'native', $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
    [org.id, c.id, c.customer_id, c.lead_id, svc?.name || cap.service || "Appointment", start, end, svc?.valueCents || 0, `capture:${c.id}`]
  );
  if (!inserted) return "none";
  if (cap.address) await q("UPDATE customers SET address = address || $2, updated_at = now() WHERE id = $1 AND (address->>'street') IS NULL", [c.customer_id, JSON.stringify({ street: cap.address })]);
  await setStatusFromCall(c.customer_id, "booked");
  await q("UPDATE calls SET outcome = 'booked', updated_at = now() WHERE id = $1 AND (outcome IS NULL OR outcome IN ('unknown','info','callback'))", [c.id]);
  log.info({ callId, bookingId: inserted.id }, "booking captured from the call");
  return "booked";
}
