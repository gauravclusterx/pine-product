export const money = (cents: number | null | undefined) =>
  cents == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);

export const num = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));

export const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export function duration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function when(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("en-US", opts).format(d);
}

export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const OUTCOME_LABEL: Record<string, string> = {
  booked: "Booked", callback: "Callback", quote: "Quote", info: "Info", not_interested: "Not interested",
  no_contact: "No answer", transferred: "Transferred", opt_out: "Opted out", unknown: "Unclear", in_progress: "In progress",
};

export const OUTCOME_TONE: Record<string, string> = {
  booked: "bg-leaf-wash text-leaf-dark", callback: "bg-plum-wash text-plum", quote: "bg-plum-wash text-plum", transferred: "bg-canvas-deep text-ink-soft",
  no_contact: "bg-canvas-deep text-ink-mute", not_interested: "bg-warn-wash text-warn", opt_out: "bg-bad-wash text-bad", info: "bg-canvas-deep text-ink-soft", unknown: "bg-canvas-deep text-ink-mute",
};

export const SOURCE_LABEL: Record<string, string> = {
  google_lsa: "Google LSA", meta: "Meta", yelp: "Yelp", angi: "Angi", thumbtack: "Thumbtack", web_form: "Website form", web_chat: "Web chat",
  email: "Lead email", manual: "Manual", api: "API", phone: "Phone",
};

export const minutesToClock = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
export const clockToMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
