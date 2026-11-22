/**
 * Billing, the same model as the Pine AI CRM:
 *
 *  Subscription — each client has a monthly subscription. Platform staff set the price and the
 *  currency per client (or use the platform default), can grant a trial or activate a period by
 *  hand. When staff switch the paywall on, a client whose subscription (or trial) is not current
 *  sees only the subscribe page; the API refuses everything else with 402.
 *
 *  Prepaid wallet — two balances per client:
 *    voice credits: 1 per call-minute, exact seconds (90 s = 1.5), minimum 1 for a connected call;
 *                   debited once per call when it ends; outbound calls need a positive balance.
 *    chat credits:  1 per message sent to a customer (SMS); refused at 0.
 *  Top-ups are priced from the client's rate: credits per 1 unit of currency, plus the client's
 *  tax percent (tax applies to top-ups only, never to the subscription).
 *
 *  Payments go through Razorpay when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set: an order is
 *  created server-side, the checkout signature is verified, and the pending payment row is claimed
 *  with a compare-and-set so a retried verification never credits twice.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { one, q, tx, type Q } from "../db/pool.js";
import { badRequest, HttpError } from "../lib/errors.js";

export type Currency = "INR" | "USD" | "GBP";
export type CreditKind = "voice" | "chat";
const COL: Record<CreditKind, string> = { voice: "wallet_voice", chat: "wallet_chat" };
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── platform settings ─────────────────────────────────────────────────────────

export interface AppSettings {
  paywallEnabled: boolean;
  defaultSubscriptionPrice: number;
  defaultCurrency: Currency;
  defaultVoicePerUnit: number;
  defaultChatPerUnit: number;
  defaultTaxPercent: number;
  trialDays: number;
  starterVoiceCredits: number;
  starterChatCredits: number;
}

export async function getSettings(): Promise<AppSettings> {
  let r = await one("SELECT * FROM app_settings WHERE id");
  if (!r) r = (await one("INSERT INTO app_settings (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET id = true RETURNING *"))!;
  return {
    paywallEnabled: r.paywall_enabled,
    defaultSubscriptionPrice: Number(r.default_subscription_price),
    defaultCurrency: r.default_currency,
    defaultVoicePerUnit: Number(r.default_voice_per_unit),
    defaultChatPerUnit: Number(r.default_chat_per_unit),
    defaultTaxPercent: Number(r.default_tax_percent),
    trialDays: r.trial_days,
    starterVoiceCredits: Number(r.starter_voice_credits),
    starterChatCredits: Number(r.starter_chat_credits),
  };
}

export async function updateSettings(p: Partial<AppSettings>): Promise<AppSettings> {
  await getSettings(); // makes sure the row exists
  const map: Record<keyof AppSettings, string> = {
    paywallEnabled: "paywall_enabled", defaultSubscriptionPrice: "default_subscription_price", defaultCurrency: "default_currency",
    defaultVoicePerUnit: "default_voice_per_unit", defaultChatPerUnit: "default_chat_per_unit", defaultTaxPercent: "default_tax_percent",
    trialDays: "trial_days", starterVoiceCredits: "starter_voice_credits", starterChatCredits: "starter_chat_credits",
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map) as Array<[keyof AppSettings, string]>) {
    if (p[k] === undefined) continue;
    vals.push(p[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length) await q(`UPDATE app_settings SET ${sets.join(", ")}, updated_at = now() WHERE id`, vals);
  return getSettings();
}

// ── a client's billing state ──────────────────────────────────────────────────

export interface OrgBilling {
  status: "inactive" | "trial" | "active" | "expired";
  active: boolean;
  suspended: boolean;
  expiresAt: string | null;
  trialEndsAt: string | null;
  trialUsed: boolean;
  price: number;
  currency: Currency;
  voicePerUnit: number;
  chatPerUnit: number;
  taxPercent: number;
  wallet: { voice: number; chat: number };
  paywallEnabled: boolean;
  /** True when this client must subscribe before using the app. */
  required: boolean;
}

/** Is the subscription or the trial current right now? Suspension overrides everything. */
export function subscriptionCurrent(o: Record<string, any>, now = new Date()): boolean {
  if (o.suspended) return false;
  if (o.subscription_status === "trial") return !!o.trial_ends_at && now < new Date(o.trial_ends_at);
  if (o.subscription_status === "active") return !!o.subscription_expires_at && now < new Date(o.subscription_expires_at);
  return false;
}

export async function orgBilling(orgId: string, s?: AppSettings): Promise<OrgBilling> {
  const settings = s || (await getSettings());
  const o = await one("SELECT * FROM orgs WHERE id = $1", [orgId]);
  if (!o) throw new HttpError(404, "not_found", "Workspace not found");
  const active = subscriptionCurrent(o);
  let status = o.subscription_status;
  if (!active && (status === "trial" || status === "active")) status = "expired";
  return {
    status, active, suspended: o.suspended,
    expiresAt: o.subscription_expires_at ? new Date(o.subscription_expires_at).toISOString() : null,
    trialEndsAt: o.trial_ends_at ? new Date(o.trial_ends_at).toISOString() : null,
    trialUsed: !!o.trial_started_at,
    price: o.subscription_price != null ? Number(o.subscription_price) : settings.defaultSubscriptionPrice,
    currency: o.currency || settings.defaultCurrency,
    voicePerUnit: o.voice_per_unit != null ? Number(o.voice_per_unit) : settings.defaultVoicePerUnit,
    chatPerUnit: o.chat_per_unit != null ? Number(o.chat_per_unit) : settings.defaultChatPerUnit,
    taxPercent: o.tax_percent != null ? Number(o.tax_percent) : settings.defaultTaxPercent,
    wallet: { voice: Number(o.wallet_voice), chat: Number(o.wallet_chat) },
    paywallEnabled: settings.paywallEnabled,
    required: settings.paywallEnabled && !active,
  };
}

/**
 * API gate for client routes. Platform staff are never blocked. A suspended client is blocked
 * always; with the paywall on, a client without a current subscription gets 402 (the web app
 * then shows the subscribe page). Billing and sign-in routes stay open.
 */
export function requireCurrentSubscription(openPrefixes: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const a = req.auth;
      if (!a || a.isPlatformAdmin || !a.orgId || openPrefixes.some((p) => req.path.startsWith(p))) return next();
      const o = await one("SELECT suspended, subscription_status, subscription_expires_at, trial_ends_at FROM orgs WHERE id = $1", [a.orgId]);
      if (!o) return next();
      if (o.suspended) return next(new HttpError(403, "suspended", "This workspace is suspended. Contact Pine AI."));
      const s = await one("SELECT paywall_enabled FROM app_settings WHERE id");
      if (s?.paywall_enabled && !subscriptionCurrent(o)) return next(new HttpError(402, "subscription_required", "Your subscription is not active. Subscribe to continue."));
      next();
    } catch (err) { next(err); }
  };
}

// ── credits ───────────────────────────────────────────────────────────────────

/** Voice credits for a call: minimum 1 for any connected call, then the exact fraction. */
export function creditsForSeconds(seconds: number): number {
  const s = Math.max(0, Number(seconds) || 0);
  if (s <= 0) return 0;
  return s <= 60 ? 1 : round2(s / 60);
}

export async function hasCredit(orgId: string, kind: CreditKind, amount = 1): Promise<boolean> {
  const r = await one(`SELECT ${COL[kind]} AS bal FROM orgs WHERE id = $1`, [orgId]);
  return !!r && Number(r.bal) >= amount;
}

/** Take exactly `amount` if the balance covers it. True when charged. */
export async function charge(orgId: string, kind: CreditKind, amount: number, reason: string, ref?: string, t: Q = q): Promise<boolean> {
  const amt = round2(amount);
  const r = await t(`UPDATE orgs SET ${COL[kind]} = ${COL[kind]} - $2 WHERE id = $1 AND ${COL[kind]} >= $2 RETURNING id`, [orgId, amt]);
  if (!r[0]) return false;
  await t("INSERT INTO wallet_ledger (org_id, kind, delta, reason, ref) VALUES ($1, $2, $3, $4, $5)", [orgId, kind, -amt, reason, ref ?? null]);
  return true;
}

/** Take up to `amount`, never below zero. Returns what was actually taken. */
export async function chargeUpTo(orgId: string, kind: CreditKind, amount: number, reason: string, ref?: string, t: Q = q): Promise<number> {
  const amt = round2(amount);
  if (amt <= 0) return 0;
  const r = await t(
    `WITH b AS (SELECT ${COL[kind]} AS before FROM orgs WHERE id = $1 FOR UPDATE)
     UPDATE orgs SET ${COL[kind]} = GREATEST(0, orgs.${COL[kind]} - $2) FROM b WHERE orgs.id = $1 RETURNING b.before`,
    [orgId, amt]
  );
  const taken = r[0] ? round2(Math.min(amt, Number(r[0].before))) : 0;
  if (taken > 0) await t("INSERT INTO wallet_ledger (org_id, kind, delta, reason, ref) VALUES ($1, $2, $3, $4, $5)", [orgId, kind, -taken, reason, ref ?? null]);
  return taken;
}

export async function addCredits(orgId: string, voice: number, chat: number, reason: string, ref?: string, t: Q = q): Promise<void> {
  const v = Math.max(0, round2(voice)), c = Math.max(0, round2(chat));
  if (!v && !c) return;
  await t("UPDATE orgs SET wallet_voice = wallet_voice + $2, wallet_chat = wallet_chat + $3 WHERE id = $1", [orgId, v, c]);
  if (v) await t("INSERT INTO wallet_ledger (org_id, kind, delta, reason, ref) VALUES ($1, 'voice', $2, $3, $4)", [orgId, v, reason, ref ?? null]);
  if (c) await t("INSERT INTO wallet_ledger (org_id, kind, delta, reason, ref) VALUES ($1, 'chat', $2, $3, $4)", [orgId, c, reason, ref ?? null]);
}

/** Staff: set a balance to an exact value (logged as the difference). */
export async function setCredits(orgId: string, kind: CreditKind, value: number, by: string): Promise<void> {
  await tx(async (t) => {
    const r = await t(`SELECT ${COL[kind]} AS bal FROM orgs WHERE id = $1 FOR UPDATE`, [orgId]);
    if (!r[0]) throw new HttpError(404, "not_found", "Workspace not found");
    const next = Math.max(0, round2(value));
    const delta = round2(next - Number(r[0].bal));
    await t(`UPDATE orgs SET ${COL[kind]} = $2 WHERE id = $1`, [orgId, next]);
    if (delta) await t("INSERT INTO wallet_ledger (org_id, kind, delta, reason, ref) VALUES ($1, $2, $3, 'admin.set', $4)", [orgId, kind, delta, by]);
  });
}

// ── top-up pricing (pure) ─────────────────────────────────────────────────────

/** Price of a credit basket in currency units, before tax. Rates are credits per 1 unit. */
export function topupCost(voice: number, chat: number, voicePerUnit: number, chatPerUnit: number): number {
  const v = Math.max(0, Number(voice) || 0), c = Math.max(0, Number(chat) || 0);
  return (v > 0 && voicePerUnit > 0 ? v / voicePerUnit : 0) + (c > 0 && chatPerUnit > 0 ? c / chatPerUnit : 0);
}
export function topupTotal(voice: number, chat: number, voicePerUnit: number, chatPerUnit: number, taxPercent = 0): { subtotal: number; tax: number; total: number } {
  const subtotal = round2(topupCost(voice, chat, voicePerUnit, chatPerUnit));
  const tax = round2((subtotal * Math.max(0, Number(taxPercent) || 0)) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// ── subscription periods ──────────────────────────────────────────────────────

/** A renewal extends a current period instead of restarting it (no lost days). */
export function nextPeriod(currentExpiry: Date | string | null, status: string, months = 1, now = new Date()): { start: Date; end: Date } {
  const cur = currentExpiry ? new Date(currentExpiry) : null;
  const start = status === "active" && cur && cur > now ? cur : now;
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  return { start, end };
}

export async function activateSubscription(orgId: string, months: number, t: Q = q): Promise<{ start: Date; end: Date }> {
  const o = (await t("SELECT subscription_status, subscription_expires_at FROM orgs WHERE id = $1 FOR UPDATE", [orgId]))[0];
  if (!o) throw new HttpError(404, "not_found", "Workspace not found");
  const p = nextPeriod(o.subscription_expires_at, o.subscription_status, months);
  await t("UPDATE orgs SET subscription_status = 'active', subscription_expires_at = $2, trial_ends_at = NULL WHERE id = $1", [orgId, p.end]);
  return p;
}

export async function startTrial(orgId: string, days: number, byStaff = false): Promise<Date> {
  return tx(async (t) => {
    const o = (await t("SELECT subscription_status, trial_started_at FROM orgs WHERE id = $1 FOR UPDATE", [orgId]))[0];
    if (!o) throw new HttpError(404, "not_found", "Workspace not found");
    if (!byStaff && o.subscription_status === "active") throw badRequest("You already have an active subscription.");
    if (!byStaff && o.trial_started_at) throw badRequest("The free trial has already been used.");
    const end = new Date(Date.now() + days * 86_400_000);
    await t("UPDATE orgs SET subscription_status = 'trial', trial_started_at = COALESCE(trial_started_at, now()), trial_ends_at = $2 WHERE id = $1", [orgId, end]);
    return end;
  });
}

// ── Razorpay ──────────────────────────────────────────────────────────────────

const rzpKey = () => process.env.RAZORPAY_KEY_ID || "";
const rzpSecret = () => process.env.RAZORPAY_KEY_SECRET || "";
export const razorpayConfigured = () => !!(rzpKey() && rzpSecret() && !rzpKey().includes("xxxx"));
export const razorpayKeyId = () => (razorpayConfigured() ? rzpKey() : "");

export async function createRazorpayOrder(amountMinor: number, currency: Currency, receipt: string): Promise<{ id: string }> {
  if (!razorpayConfigured()) throw new HttpError(503, "payments_off", "Online payment is not set up yet. Contact Pine AI to activate your plan.");
  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${rzpKey()}:${rzpSecret()}`).toString("base64") },
    body: JSON.stringify({ amount: amountMinor, currency, receipt: receipt.slice(0, 40) }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data.id) throw new HttpError(502, "payment_provider", `Payment provider error: ${data?.error?.description || r.status}`);
  return { id: data.id };
}

export function razorpaySignatureValid(orderId: string, paymentId: string, signature: string): boolean {
  if (!rzpSecret() || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", rzpSecret()).update(`${orderId}|${paymentId}`).digest("hex");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Apply a verified payment once: claim the pending row (compare-and-set), then activate the period
 * or add the credits in the same transaction. Returns null when it was already applied.
 */
export async function applyPayment(orgId: string, orderId: string, paymentId: string): Promise<{ kind: string; voice: number; chat: number; periodEnd?: Date } | null> {
  return tx(async (t) => {
    const p = (await t("UPDATE payments SET status = 'success', payment_id = $3 WHERE org_id = $1 AND order_id = $2 AND status = 'pending' RETURNING *", [orgId, orderId, paymentId]))[0];
    if (!p) return null;
    if (p.kind === "subscription") {
      const period = await activateSubscription(orgId, 1, t);
      await t("UPDATE payments SET period_start = $2, period_end = $3 WHERE id = $1", [p.id, period.start, period.end]);
      return { kind: p.kind, voice: 0, chat: 0, periodEnd: period.end };
    }
    await addCredits(orgId, Number(p.voice_credits), Number(p.chat_credits), "topup", p.id, t);
    return { kind: p.kind, voice: Number(p.voice_credits), chat: Number(p.chat_credits) };
  });
}

/** Server-side automation (outbound calls, campaigns) stops when the paywall is on and the subscription lapsed, or when suspended. */
export async function automationAllowed(orgId: string): Promise<boolean> {
  const o = await one("SELECT suspended, subscription_status, subscription_expires_at, trial_ends_at FROM orgs WHERE id = $1", [orgId]);
  if (!o || o.suspended) return false;
  const s = await one("SELECT paywall_enabled FROM app_settings WHERE id");
  return !s?.paywall_enabled || subscriptionCurrent(o);
}
