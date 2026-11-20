/**
 * Time-zone arithmetic without a date library. Every client works in its own zone; every
 * timestamp is stored in UTC.
 */

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The wall-clock reading of an instant in a zone. weekday: 0 = Sunday. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** Minutes after local midnight of an instant in a zone. */
export function minuteOfDay(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  return p.hour * 60 + p.minute;
}

/**
 * The instant at which a zone's wall clock reads the given local time. Across a DST gap the
 * result is the first instant after the gap; across an overlap it is the earlier of the two.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Tue, Nov 24 at 2:00 PM" in the zone — how an agent or an SMS says a time. */
export function speakTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(at).replace(/,\s(\d{1,2}:\d{2})/, " at $1");
}

export interface DayHours { open: number; close: number }
/** Weekly opening hours: index 0 = Sunday. null = closed that day. Minutes after midnight. */
export type WeekHours = Array<DayHours | null>;

export const DEFAULT_WEEK_HOURS: WeekHours = [null, { open: 480, close: 1020 }, { open: 480, close: 1020 }, { open: 480, close: 1020 }, { open: 480, close: 1020 }, { open: 480, close: 1020 }, null];

/** Accepts stored hours, falling back to Mon–Fri 8:00–17:00 when missing or malformed. */
export function parseWeekHours(raw: unknown): WeekHours {
  if (!Array.isArray(raw) || raw.length !== 7) return DEFAULT_WEEK_HOURS;
  return raw.map((d: any) => {
    if (!d || typeof d !== "object") return null;
    const open = Number(d.open), close = Number(d.close);
    if (!Number.isInteger(open) || !Number.isInteger(close) || open < 0 || close > 1440 || open >= close) return null;
    return { open, close };
  });
}

export function isWithinHours(at: Date, tz: string, hours: WeekHours): boolean {
  const p = zonedParts(at, tz);
  const day = hours[p.weekday];
  if (!day) return false;
  const m = p.hour * 60 + p.minute;
  return m >= day.open && m < day.close;
}

/**
 * Outbound calling window (TCPA: 8:00–21:00 in the called party's local time; we use the
 * client's zone and a narrower default). Returns the instant calling may next start: `at`
 * itself when inside the window.
 */
export function nextCallableTime(at: Date, tz: string, opensMinute: number, closesMinute: number): Date {
  const m = minuteOfDay(at, tz);
  if (m >= opensMinute && m < closesMinute) return at;
  const p = zonedParts(at, tz);
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const date = m < opensMinute ? today : addDays(today, 1);
  const [y, mo, d] = date.split("-").map(Number);
  return zonedTimeToUtc(y, mo, d, Math.floor(opensMinute / 60), opensMinute % 60, tz);
}
