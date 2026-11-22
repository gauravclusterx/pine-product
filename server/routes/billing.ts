/**
 * Billing routes — the client's subscription + wallet, and the admin panel's controls for them.
 * Same model as the Pine AI CRM (see modules/billing.ts). Mounted inside the signed-in API router.
 *
 * Client (owner only for purchases):
 *   GET  /billing                      state, prices, wallet, payments, recent usage
 *   POST /billing/trial                start the one free trial
 *   POST /billing/subscribe/order      Razorpay order for one month
 *   POST /billing/topup/order          Razorpay order for { voice, chat } credits
 *   POST /billing/verify               verify the checkout signature → activate / add credits
 *
 * Admin panel (platform admins):
 *   GET/PUT /admin/settings            paywall on/off, default price, currency, rates, trial days
 *   GET  /admin/customers              every client with owner, subscription, wallet, usage
 *   GET  /admin/customers/:id          one client in full (members, payments, ledger, voice)
 *   PATCH /admin/customers/:id/billing price, currency, rates, tax, suspend
 *   POST /admin/customers/:id/trial    grant N trial days
 *   POST /admin/customers/:id/activate activate N months by hand (records a manual payment)
 *   PUT  /admin/customers/:id/credits  set or add voice / message credits
 *   GET  /admin/payments               every payment
 */
import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, P, parse, uuid } from "../http.js";
import { audit, requirePlatformAdmin, requireRole } from "../auth/auth.js";
import {
  activateSubscription, addCredits, applyPayment, createRazorpayOrder, getSettings, orgBilling, razorpayConfigured, razorpayKeyId,
  razorpaySignatureValid, setCredits, startTrial, topupTotal, updateSettings, type Currency,
} from "../modules/billing.js";
import { createOrg } from "../modules/orgs.js";

export const billingRouter = Router();
const owner = requireRole("owner");
const viewer = requireRole("viewer");
const CURRENCY = z.enum(["INR", "USD", "GBP"]);

/** A customer who signs up on their own gets a workspace they own (starter credits from settings). */
export async function createCustomerWorkspace(userId: string, name: string, email: string): Promise<string> {
  const label = (name || email.split("@")[0]).trim();
  const org = await createOrg({ name: `${label}'s business`.slice(0, 120), industry: "other", timezone: "Asia/Kolkata", rateCentsPerMinute: 25 });
  const s = await getSettings();
  await tx(async (t) => {
    await t("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [org.id, userId]);
    await t("UPDATE orgs SET subscription_status = 'inactive', subscription_expires_at = NULL WHERE id = $1", [org.id]);
    await addCredits(org.id, s.starterVoiceCredits, s.starterChatCredits, "starter", undefined, t);
  });
  await audit(org.id, userId, "org.self_signup", { email });
  return org.id;
}

// ── client ────────────────────────────────────────────────────────────────────

billingRouter.get("/billing", viewer, h(async (req, res) => {
  const orgId = req.auth!.orgId;
  const b = await orgBilling(orgId);
  const payments = await q("SELECT id, kind, provider, amount_minor, currency, status, voice_credits, chat_credits, period_end, note, created_at FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50", [orgId]);
  const usage = await q("SELECT kind, delta, reason, ref, created_at FROM wallet_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50", [orgId]);
  const [month] = await q(
    `SELECT COALESCE(sum(-delta) FILTER (WHERE kind = 'voice' AND delta < 0), 0)::float AS voice_used,
            COALESCE(sum(-delta) FILTER (WHERE kind = 'chat' AND delta < 0), 0)::float AS chat_used
     FROM wallet_ledger WHERE org_id = $1 AND created_at >= date_trunc('month', now())`,
    [orgId]
  );
  const s = await getSettings();
  res.json({ ...b, trialDays: s.trialDays, payments, usage, month, payments_online: razorpayConfigured(), razorpayKeyId: razorpayKeyId() });
}));

billingRouter.post("/billing/trial", owner, h(async (req, res) => {
  const s = await getSettings();
  if (s.trialDays <= 0) throw badRequest("Free trials are not offered right now.");
  const end = await startTrial(req.auth!.orgId, s.trialDays);
  await audit(req.auth!.orgId, req.auth!.userId, "billing.trial_started", { until: end });
  res.json({ ok: true, trialEndsAt: end });
}));

billingRouter.post("/billing/subscribe/order", owner, h(async (req, res) => {
  const orgId = req.auth!.orgId;
  const b = await orgBilling(orgId);
  if (!(b.price > 0)) throw badRequest("A subscription price is not set for your account. Contact Pine AI.");
  const amountMinor = Math.max(100, Math.round(b.price * 100));
  const order = await createRazorpayOrder(amountMinor, b.currency, `sub_${orgId.slice(0, 8)}_${Date.now()}`);
  await q("INSERT INTO payments (org_id, kind, order_id, amount_minor, currency, created_by) VALUES ($1, 'subscription', $2, $3, $4, $5)", [orgId, order.id, amountMinor, b.currency, req.auth!.userId]);
  res.json({ orderId: order.id, amount: amountMinor, currency: b.currency, keyId: razorpayKeyId(), name: req.auth!.name, email: req.auth!.email });
}));

billingRouter.post("/billing/topup/order", owner, h(async (req, res) => {
  const { voice, chat } = parse(z.object({ voice: z.number().min(0).max(1_000_000).default(0), chat: z.number().min(0).max(10_000_000).default(0) }), req.body);
  if (voice <= 0 && chat <= 0) throw badRequest("Enter voice and/or message credits to buy.");
  const orgId = req.auth!.orgId;
  const b = await orgBilling(orgId);
  const price = topupTotal(voice, chat, b.voicePerUnit, b.chatPerUnit, b.taxPercent);
  const amountMinor = Math.max(100, Math.round(price.total * 100));
  const order = await createRazorpayOrder(amountMinor, b.currency, `top_${orgId.slice(0, 8)}_${Date.now()}`);
  await q("INSERT INTO payments (org_id, kind, order_id, amount_minor, currency, voice_credits, chat_credits, created_by) VALUES ($1, 'topup', $2, $3, $4, $5, $6, $7)", [orgId, order.id, amountMinor, b.currency, voice, chat, req.auth!.userId]);
  res.json({ orderId: order.id, amount: amountMinor, currency: b.currency, keyId: razorpayKeyId(), price, name: req.auth!.name, email: req.auth!.email });
}));

billingRouter.post("/billing/verify", owner, h(async (req, res) => {
  const b = parse(z.object({ razorpay_order_id: z.string().min(4), razorpay_payment_id: z.string().min(4), razorpay_signature: z.string().min(10) }), req.body);
  if (!razorpaySignatureValid(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) throw badRequest("Payment verification failed.");
  const r = await applyPayment(req.auth!.orgId, b.razorpay_order_id, b.razorpay_payment_id);
  if (r) await audit(req.auth!.orgId, req.auth!.userId, `billing.${r.kind}_paid`, { orderId: b.razorpay_order_id });
  res.json({ ok: true, already: !r, result: r });
}));

// ── admin panel ───────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  paywallEnabled: z.boolean().optional(),
  defaultSubscriptionPrice: z.number().min(0).max(10_000_000).optional(),
  defaultCurrency: CURRENCY.optional(),
  defaultVoicePerUnit: z.number().positive().max(100_000).optional(),
  defaultChatPerUnit: z.number().positive().max(1_000_000).optional(),
  defaultTaxPercent: z.number().min(0).max(100).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  starterVoiceCredits: z.number().min(0).max(100_000).optional(),
  starterChatCredits: z.number().min(0).max(1_000_000).optional(),
});

billingRouter.get("/admin/settings", requirePlatformAdmin, h(async (_req, res) => {
  res.json({ ...(await getSettings()), paymentsOnline: razorpayConfigured() });
}));

billingRouter.put("/admin/settings", requirePlatformAdmin, h(async (req, res) => {
  const p = parse(settingsSchema, req.body);
  const s = await updateSettings(p);
  await audit(null, req.auth!.userId, "admin.settings_changed", p);
  res.json({ ...s, paymentsOnline: razorpayConfigured() });
}));

billingRouter.get("/admin/customers", requirePlatformAdmin, h(async (_req, res) => {
  const s = await getSettings();
  const rows = await q(
    `SELECT o.id, o.name, o.industry, o.status, o.created_at, o.suspended, o.subscription_status, o.subscription_expires_at, o.trial_ends_at,
            COALESCE(o.subscription_price, $1) AS price, COALESCE(o.currency, $2) AS currency, o.wallet_voice::float AS wallet_voice, o.wallet_chat::float AS wallet_chat,
            (v.org_id IS NOT NULL) AS voice_connected,
            (SELECT count(*)::int FROM agents a WHERE a.org_id = o.id AND a.status = 'live') AS live_agents,
            (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
            (SELECT count(*)::int FROM calls c WHERE c.org_id = o.id AND c.started_at >= date_trunc('month', now())) AS calls_month,
            (SELECT COALESCE(sum(c.billed_credits), 0)::float FROM calls c WHERE c.org_id = o.id AND c.started_at >= date_trunc('month', now())) AS minutes_month,
            (SELECT max(u.last_login_at) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id) AS last_login_at
     FROM orgs o LEFT JOIN voice_workspaces v ON v.org_id = o.id ORDER BY o.created_at DESC`,
    [s.defaultSubscriptionPrice, s.defaultCurrency]
  );
  const now = new Date();
  res.json({
    settings: s,
    customers: rows.map((r) => ({
      ...r, price: Number(r.price),
      active: !r.suspended && ((r.subscription_status === "trial" && r.trial_ends_at && new Date(r.trial_ends_at) > now) || (r.subscription_status === "active" && r.subscription_expires_at && new Date(r.subscription_expires_at) > now)),
    })),
  });
}));

billingRouter.get("/admin/customers/:id", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const org = await one("SELECT id, name, industry, timezone, status, created_at, rate_cents_per_minute FROM orgs WHERE id = $1", [id]);
  if (!org) throw notFound();
  const [billing, members, payments, ledger, voice, usage] = await Promise.all([
    orgBilling(id),
    q("SELECT u.id, u.email, u.name, m.role, u.last_login_at, u.disabled FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.role DESC, u.email", [id]),
    q("SELECT id, kind, provider, amount_minor, currency, status, voice_credits, chat_credits, period_end, note, created_at FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50", [id]),
    q("SELECT kind, delta, reason, ref, created_at FROM wallet_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50", [id]),
    one("SELECT workspace_id, connected_at, (webhook_secret_enc IS NOT NULL) AS webhook_secret_set FROM voice_workspaces WHERE org_id = $1", [id]),
    one(`SELECT count(*)::int AS calls, COALESCE(sum(billed_credits), 0)::float AS minutes, count(*) FILTER (WHERE outcome = 'booked')::int AS booked
         FROM calls WHERE org_id = $1 AND started_at >= date_trunc('month', now())`, [id]),
  ]);
  res.json({ org, billing, members, payments, ledger, voice, usage });
}));

billingRouter.patch("/admin/customers/:id/billing", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const b = parse(z.object({
    subscriptionPrice: z.number().min(0).max(10_000_000).nullable().optional(),
    currency: CURRENCY.nullable().optional(),
    voicePerUnit: z.number().positive().max(100_000).nullable().optional(),
    chatPerUnit: z.number().positive().max(1_000_000).nullable().optional(),
    taxPercent: z.number().min(0).max(100).nullable().optional(),
    suspended: z.boolean().optional(),
    endSubscription: z.boolean().optional(),
  }), req.body);
  const map: Record<string, string> = { subscriptionPrice: "subscription_price", currency: "currency", voicePerUnit: "voice_per_unit", chatPerUnit: "chat_per_unit", taxPercent: "tax_percent", suspended: "suspended" };
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) {
    if ((b as any)[k] === undefined) continue;
    vals.push((b as any)[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (b.endSubscription) sets.push("subscription_status = 'expired'", "subscription_expires_at = now()", "trial_ends_at = NULL");
  if (sets.length) {
    const r = await one(`UPDATE orgs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
    if (!r) throw notFound();
  }
  await audit(id, req.auth!.userId, "admin.billing_changed", b);
  res.json(await orgBilling(id));
}));

billingRouter.post("/admin/customers/:id/trial", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const { days } = parse(z.object({ days: z.number().int().min(1).max(365) }), req.body);
  await startTrial(id, days, true);
  await audit(id, req.auth!.userId, "admin.trial_granted", { days });
  res.json(await orgBilling(id));
}));

billingRouter.post("/admin/customers/:id/activate", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const { months, amount, note } = parse(z.object({ months: z.number().int().min(1).max(36), amount: z.number().min(0).max(10_000_000).default(0), note: z.string().max(300).default("") }), req.body);
  const b = await orgBilling(id);
  await tx(async (t) => {
    const p = await activateSubscription(id, months, t);
    await t(
      "INSERT INTO payments (org_id, kind, provider, amount_minor, currency, status, period_start, period_end, created_by, note) VALUES ($1, 'subscription', 'manual', $2, $3, 'success', $4, $5, $6, $7)",
      [id, Math.round(amount * 100), b.currency as Currency, p.start, p.end, req.auth!.userId, note || `activated ${months} month(s) by admin`]
    );
  });
  await audit(id, req.auth!.userId, "admin.subscription_activated", { months, amount });
  res.json(await orgBilling(id));
}));

billingRouter.put("/admin/customers/:id/credits", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const { mode, voice, chat } = parse(z.object({ mode: z.enum(["set", "add"]), voice: z.number().min(0).max(10_000_000).optional(), chat: z.number().min(0).max(10_000_000).optional() }), req.body);
  if (mode === "add") await addCredits(id, voice || 0, chat || 0, "admin.add", req.auth!.userId);
  else {
    if (voice !== undefined) await setCredits(id, "voice", voice, req.auth!.userId);
    if (chat !== undefined) await setCredits(id, "chat", chat, req.auth!.userId);
  }
  await audit(id, req.auth!.userId, "admin.credits_changed", { mode, voice, chat });
  res.json(await orgBilling(id));
}));

billingRouter.get("/admin/payments", requirePlatformAdmin, h(async (_req, res) => {
  res.json({
    payments: await q(
      `SELECT p.id, p.kind, p.provider, p.amount_minor, p.currency, p.status, p.voice_credits, p.chat_credits, p.period_end, p.note, p.created_at, o.id AS org_id, o.name AS org_name
       FROM payments p JOIN orgs o ON o.id = p.org_id ORDER BY p.created_at DESC LIMIT 200`
    ),
  });
}));
