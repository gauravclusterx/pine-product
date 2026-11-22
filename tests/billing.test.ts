import { beforeEach, describe, expect, it } from "vitest";
import { makeOrg, resetDb } from "./helpers.js";
import { one, q } from "../server/db/pool.js";
import {
  addCredits, charge, chargeUpTo, creditsForSeconds, getSettings, nextPeriod, orgBilling, startTrial, subscriptionCurrent, topupTotal, updateSettings,
} from "../server/modules/billing.js";

beforeEach(async () => { await resetDb(); });

describe("billing maths (same as the CRM)", () => {
  it("bills a connected call at least 1 credit, then exact minutes", () => {
    expect(creditsForSeconds(0)).toBe(0);
    expect(creditsForSeconds(10)).toBe(1);
    expect(creditsForSeconds(60)).toBe(1);
    expect(creditsForSeconds(90)).toBe(1.5);
    expect(creditsForSeconds(165)).toBe(2.75);
  });

  it("prices a top-up from the per-unit rates, with tax on top", () => {
    // 100 voice credits at 0.2 credits/unit = 500, 200 message credits at 2/unit = 100 → 600 + 18% = 708
    expect(topupTotal(100, 200, 0.2, 2, 18)).toEqual({ subtotal: 600, tax: 108, total: 708 });
    expect(topupTotal(0, 0, 0.2, 2, 18).total).toBe(0);
  });

  it("extends a current subscription instead of restarting it", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const end = new Date("2026-01-20T00:00:00Z");
    expect(nextPeriod(end, "active", 1, now).start).toEqual(end);
    expect(nextPeriod(end, "expired", 1, now).start).toEqual(now);
  });

  it("treats suspension and lapsed periods as not current", () => {
    const future = new Date(Date.now() + 86_400_000), past = new Date(Date.now() - 1000);
    expect(subscriptionCurrent({ subscription_status: "active", subscription_expires_at: future, trial_ends_at: null })).toBe(true);
    expect(subscriptionCurrent({ subscription_status: "active", subscription_expires_at: past, trial_ends_at: null })).toBe(false);
    expect(subscriptionCurrent({ subscription_status: "trial", subscription_expires_at: null, trial_ends_at: future })).toBe(true);
    expect(subscriptionCurrent({ suspended: true, subscription_status: "active", subscription_expires_at: future, trial_ends_at: null })).toBe(false);
  });
});

describe("wallet", () => {
  it("charges only when the balance covers it and logs every movement", async () => {
    const o = await makeOrg();
    await q("UPDATE orgs SET wallet_chat = 1 WHERE id = $1", [o.id]);
    expect(await charge(o.id, "chat", 1, "sms")).toBe(true);
    expect(await charge(o.id, "chat", 1, "sms")).toBe(false);
    expect(Number((await one("SELECT wallet_chat FROM orgs WHERE id = $1", [o.id]))!.wallet_chat)).toBe(0);
    expect((await q("SELECT delta FROM wallet_ledger WHERE org_id = $1", [o.id])).map((r) => Number(r.delta))).toEqual([-1]);
  });

  it("takes what is there when a call costs more than the balance, never going negative", async () => {
    const o = await makeOrg();
    await q("UPDATE orgs SET wallet_voice = 2 WHERE id = $1", [o.id]);
    expect(await chargeUpTo(o.id, "voice", 3.5, "call")).toBe(2);
    expect(await chargeUpTo(o.id, "voice", 1, "call")).toBe(0);
    await addCredits(o.id, 10, 5, "topup");
    const b = await orgBilling(o.id);
    expect(b.wallet).toEqual({ voice: 10, chat: 1005 });
  });
});

describe("subscription", () => {
  it("is required only when the paywall is on, and a trial satisfies it once", async () => {
    const o = await makeOrg();
    await q("UPDATE orgs SET subscription_status = 'inactive', subscription_expires_at = NULL WHERE id = $1", [o.id]);
    expect((await orgBilling(o.id)).required).toBe(false);
    await updateSettings({ paywallEnabled: true, trialDays: 7 });
    expect((await getSettings()).paywallEnabled).toBe(true);
    expect((await orgBilling(o.id)).required).toBe(true);
    await startTrial(o.id, 7);
    expect((await orgBilling(o.id)).required).toBe(false);
    await expect(startTrial(o.id, 7)).rejects.toThrow(/already been used/);
  });
});
