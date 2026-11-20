/**
 * Arrival windows. All clock arithmetic happens here, in the client's time zone — a language
 * model is never trusted with it (a model will happily read "four PM" as 04:00).
 */
import type { Org } from "../modules/orgs.js";
import { businessHoursOf } from "../modules/orgs.js";
import { addDays, localDate, speakTime, zonedTimeToUtc } from "../lib/time.js";
import type { Slot } from "./types.js";
import { monthDayOf, normaliseSpokenNumbers } from "../lib/spoken.js";

/**
 * Every arrival window the business could offer between two instants: consecutive windows of
 * `slotMinutes` inside each day's opening hours, starting at least `leadMinutes` from now.
 */
export function candidateSlots(org: Org, from: Date, to: Date, opts: { now?: Date; leadMinutes?: number } = {}): Slot[] {
  const tz = org.timezone;
  const hours = businessHoursOf(org);
  const size = org.settings.slotMinutes;
  const now = opts.now ?? new Date();
  const earliest = new Date(Math.max(from.getTime(), now.getTime() + (opts.leadMinutes ?? 60) * 60_000));
  const horizon = new Date(now.getTime() + org.settings.bookingHorizonDays * 86_400_000);
  const last = new Date(Math.min(to.getTime(), horizon.getTime()));
  const out: Slot[] = [];
  if (last <= earliest) return out;

  let day = localDate(earliest, tz);
  const endDay = localDate(last, tz);
  for (let guard = 0; guard < 70 && day <= endDay; guard++, day = addDays(day, 1)) {
    const [y, m, d] = day.split("-").map(Number);
    // Weekday of this local date (noon avoids any DST edge).
    const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
    const h = hours[weekday];
    if (!h) continue;
    for (let start = h.open; start + size <= h.close; start += size) {
      const s = zonedTimeToUtc(y, m, d, Math.floor(start / 60), start % 60, tz);
      const e = new Date(s.getTime() + size * 60_000);
      if (s >= earliest && e <= last) out.push({ start: s, end: e });
    }
  }
  return out;
}

/** Remove candidates that overlap any busy interval. */
export function subtractBusy(slots: Slot[], busy: Array<{ start: Date; end: Date }>): Slot[] {
  return slots.filter((s) => !busy.some((b) => b.start < s.end && b.end > s.start));
}

/** How a slot is said aloud and written in a text: "Tue, Nov 24 at 2:00 PM – 4:00 PM". */
export function slotLabel(slot: Slot, tz: string): string {
  const end = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(slot.end);
  return `${speakTime(slot.start, tz)} – ${end}`;
}

/**
 * Resolve the time an agent passed back. Agents are told to return the `start` value of a slot
 * we offered, verbatim; anything that is not an exact ISO instant is rejected rather than guessed.
 */
export function parseSlotStart(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolve "today", "tomorrow", a weekday name or YYYY-MM-DD into a local date range (UTC instants). */
export function resolveDayRange(raw: unknown, tz: string, now: Date = new Date()): { from: Date; to: Date } | null {
  const s = normaliseSpokenNumbers(String(raw ?? "")).replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  const today = localDate(now, tz);
  let date: string | null = null;
  if (!s || s === "any" || s === "soonest" || s === "asap") return null;
  const md = monthDayOf(s);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s);
  if (iso) date = iso[1];
  else if (/\b(day after tomorrow|parso)\b/.test(s)) date = addDays(today, 2);
  else if (/\b(today|aaj|tonight)\b/.test(s)) date = today;
  else if (/\b(tomorrow|kal)\b/.test(s)) date = addDays(today, 1);
  else if (md) {
    // "21st November": this year, or next year once the date has passed.
    const y = Number(today.slice(0, 4));
    const candidate = `${y}-${String(md.month).padStart(2, "0")}-${String(md.day).padStart(2, "0")}`;
    date = candidate < today ? `${y + 1}${candidate.slice(4)}` : candidate;
  } else {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const idx = names.findIndex((n) => new RegExp(`\\b(${n}|${n.slice(0, 3)})\\b`).test(s));
    if (idx >= 0) {
      const [y, m, d] = today.split("-").map(Number);
      const cur = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
      // The next occurrence of that weekday, today excluded ("Friday" said on a Friday = next week).
      const ahead = ((idx - cur + 7) % 7) || 7;
      date = addDays(today, ahead);
    }
  }
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  // Reject impossible dates ("31st February") instead of letting Date roll them over.
  const check = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(check.getTime()) || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  const from = zonedTimeToUtc(y, m, d, 0, 0, tz);
  const next = addDays(date, 1).split("-").map(Number);
  const to = zonedTimeToUtc(next[0], next[1], next[2], 0, 0, tz);
  return { from, to };
}
