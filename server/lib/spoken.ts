/**
 * Speech-to-text writes numbers as words ("twenty-first of November, five PM"). These helpers
 * turn them into digits so deterministic parsers can read them. Ported from the Pine AI CRM,
 * where spelled-out dates broke every booking on the first live test call (20 Nov 2026).
 */

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const ORDINAL_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19,
};
const suffix = (n: number) => (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";

export const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function normaliseSpokenNumbers(text: string): string {
  let t = ` ${String(text || "").toLowerCase()} `.replace(/[–—]/g, "-");
  t = t.replace(/\b(twenty|thirty)[\s-]+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g,
    (_m, tens, unit) => { const n = (tens === "twenty" ? 20 : 30) + ORDINAL_UNITS[unit]; return `${n}${suffix(n)}`; });
  t = t.replace(/\btwentieth\b/g, "20th").replace(/\bthirtieth\b/g, "30th");
  const ords = Object.keys(ORDINAL_UNITS).join("|");
  t = t.replace(new RegExp(`\\b(${ords})\\b(?=\\s+(?:of\\s+)?${MONTH}\\b)`, "g"), (w) => { const n = ORDINAL_UNITS[w]; return `${n}${suffix(n)}`; });
  t = t.replace(new RegExp(`\\b(${MONTH})\\s+(?:the\\s+)?(${ords})\\b`, "g"), (_m, mon, w) => { const n = ORDINAL_UNITS[w]; return `${mon} ${n}${suffix(n)}`; });
  t = t.replace(/\b(\d{1,2}(?:st|nd|rd|th)?)\s+of\s+(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g, "$1 ");
  const H = Object.keys(UNITS).join("|");
  t = t.replace(new RegExp(`\\bhalf\\s+past\\s+(${H}|\\d{1,2})\\b`, "g"), (_m, h) => `${UNITS[h] ?? h}:30`);
  t = t.replace(new RegExp(`\\bquarter\\s+past\\s+(${H}|\\d{1,2})\\b`, "g"), (_m, h) => `${UNITS[h] ?? h}:15`);
  t = t.replace(new RegExp(`\\bquarter\\s+to\\s+(${H}|\\d{1,2})\\b`, "g"), (_m, h) => { const n = Number(UNITS[h] ?? h); return `${n === 1 ? 12 : n - 1}:45`; });
  t = t.replace(new RegExp(`\\b(${H})[\\s-]+(fifteen|thirty|forty[\\s-]?five|o'?\\s?clock)\\b`, "g"), (_m, h, mm) => {
    const min = mm.startsWith("fif") ? "15" : mm.startsWith("thi") ? "30" : mm.startsWith("for") ? "45" : "00";
    return `${UNITS[h]}:${min}`;
  });
  t = t.replace(new RegExp(`\\b(${H})\\b(?=\\s*(?:a\\.?m\\b|p\\.?m\\b|in the|at night|tonight|morning|evening|afternoon|o'?clock))`, "g"), (w) => String(UNITS[w]));
  t = t.replace(new RegExp(`\\b(at|around|by|after|before)\\s+(${H})\\b`, "g"), (_m, p, w) => `${p} ${UNITS[w]}`);
  t = t.replace(/\bo'?\s?clock\b/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** "21st november" / "november 21" → { month, day }, or null. Operates on normalised text. */
export function monthDayOf(text: string): { month: number; day: number } | null {
  const t = String(text || "").toLowerCase();
  const a = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\b`).exec(t);
  const b = a ? null : new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  const day = Number(a ? a[1] : b ? b[2] : NaN);
  const mon = (a ? a[2] : b ? b[1] : "").slice(0, 3);
  const month = MONTHS[mon];
  if (!month || !(day >= 1 && day <= 31)) return null;
  return { month, day };
}

/** Hour and minute named in normalised text ("5 pm", "5:30 pm", "17:00"), or null. */
export function timeOf(text: string): { hour: number; minute: number } | null {
  const t = String(text || "").toLowerCase()
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "g"), " ")
    .replace(new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "g"), " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\W|$)/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ap = (m[3] || "").replace(/\./g, "");
  if (hour > 23 || minute > 59) return null;
  if (ap.startsWith("p") && hour < 12) hour += 12;
  else if (ap.startsWith("a") && hour === 12) hour = 0;
  // No am/pm: a service visit at "5" means 17:00, not 05:00.
  else if (!ap && hour >= 1 && hour <= 7) hour += 12;
  if (!ap && /\b(evening|afternoon|tonight|night)\b/.test(t) && hour < 12) hour += 12;
  return { hour, minute };
}
