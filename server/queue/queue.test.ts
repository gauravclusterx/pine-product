import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, uniq } from "../../tests/helpers.js";
import { q } from "../db/pool.js";
import { backoffMs, claim, createWorker, DeferJob, enqueue, PermanentJobError, queueStats, takeRateSlot } from "./queue.js";
import { decrypt, encrypt, hashSecret, newSecret, secretMatchesHash } from "../lib/crypto.js";

beforeEach(resetDb);

describe("migrations", () => {
  it("create the schema and are recorded once", async () => {
    const rows = await q("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toContain("001_init.sql");
    const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map((r) => r.tablename);
    for (const t of ["orgs", "users", "memberships", "agents", "calls", "leads", "bookings", "campaigns", "integrations", "jobs", "dnc_list", "webhook_deliveries"]) {
      expect(tables).toContain(t);
    }
  });
});

describe("secrets at rest", () => {
  it("round-trips, and never produces the same ciphertext twice", () => {
    const a = encrypt("ra_live_key");
    const b = encrypt("ra_live_key");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("ra_live_key");
    expect(decrypt(a)).toBe("ra_live_key");
    expect(decrypt(b)).toBe("ra_live_key");
  });
  it("refuses a tampered or malformed ciphertext instead of returning garbage", () => {
    const c = encrypt("secret");
    const parts = c.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("other-bytes").toString("base64url")].join(".");
    expect(() => decrypt(flipped)).toThrow(/unreadable secret/);
    expect(() => decrypt("plain-text")).toThrow(/unknown format/);
    expect(() => decrypt("")).toThrow();
  });
  it("compares hashed secrets in constant time and rejects near misses", () => {
    const s = newSecret();
    const h = hashSecret(s);
    expect(secretMatchesHash(s, h)).toBe(true);
    expect(secretMatchesHash(s.slice(0, -1) + (s.endsWith("A") ? "B" : "A"), h)).toBe(false);
    expect(secretMatchesHash("", h)).toBe(false);
    expect(secretMatchesHash(s, "")).toBe(false);
    expect(newSecret()).not.toBe(newSecret());
  });
});

describe("job queue", () => {
  it("runs a job once and marks it done", async () => {
    const seen: any[] = [];
    await enqueue("t", { a: 1 });
    const w = createWorker({ handlers: { t: async (j) => { seen.push(j.payload); } } });
    expect(await w.drain()).toBe(1);
    expect(seen).toEqual([{ a: 1 }]);
    expect((await q("SELECT status FROM jobs"))[0].status).toBe("done");
    expect(await w.drain()).toBe(0);
  });

  it("does not run a job before its time", async () => {
    await enqueue("t", {}, { runAt: new Date(Date.now() + 60_000) });
    const w = createWorker({ handlers: { t: async () => {} } });
    expect(await w.drain()).toBe(0);
  });

  it("a claimed job is invisible to a second worker", async () => {
    await enqueue("t", {});
    const first = await claim(["t"], 5, "w1");
    const second = await claim(["t"], 5, "w2");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("many workers racing for the same jobs each take a job exactly once", async () => {
    for (let i = 0; i < 40; i++) await enqueue("t", { i });
    const claims = await Promise.all(Array.from({ length: 8 }, (_, w) => claim(["t"], 10, "w" + w)));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it("takes over a job whose worker died (lock older than the visibility window)", async () => {
    await enqueue("t", {});
    await claim(["t"], 1, "dead-worker");
    expect(await claim(["t"], 1, "w2")).toHaveLength(0);
    await q("UPDATE jobs SET locked_at = now() - interval '10 minutes'");
    const taken = await claim(["t"], 1, "w2");
    expect(taken).toHaveLength(1);
    expect(taken[0].attempts).toBe(2);
  });

  it("retries a failing job with backoff, then parks it as dead with the last error", async () => {
    await enqueue("t", {}, { maxAttempts: 2 });
    let calls = 0;
    const w = createWorker({ handlers: { t: async () => { calls++; throw new Error("boom " + calls); } } });
    await w.drain();
    let row = (await q("SELECT status, attempts, run_at, last_error FROM jobs"))[0];
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 3000);
    expect(row.last_error).toBe("boom 1");
    await q("UPDATE jobs SET run_at = now()");
    await w.drain();
    row = (await q("SELECT status, attempts, last_error FROM jobs"))[0];
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("boom 2");
    expect(calls).toBe(2);
  });

  it("a deferred job comes back later without spending an attempt", async () => {
    await enqueue("t", {});
    const w = createWorker({ handlers: { t: async () => { throw new DeferJob(30_000, "rate limited"); } } });
    await w.drain();
    const row = (await q("SELECT status, attempts, run_at FROM jobs"))[0];
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it("a permanent error is not retried", async () => {
    await enqueue("t", {});
    let calls = 0;
    const w = createWorker({ handlers: { t: async () => { calls++; throw new PermanentJobError("bad number"); } } });
    await w.drain();
    expect(calls).toBe(1);
    const row = (await q("SELECT status, last_error FROM jobs"))[0];
    expect(row).toMatchObject({ status: "dead", last_error: "bad number" });
  });

  it("dedupeKey allows one live job per key, and a new one after it finished", async () => {
    const key = uniq("lead");
    expect(await enqueue("t", {}, { dedupeKey: key })).not.toBeNull();
    expect(await enqueue("t", {}, { dedupeKey: key })).toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM jobs"))[0].n).toBe(1);
    await createWorker({ handlers: { t: async () => {} } }).drain();
    expect(await enqueue("t", {}, { dedupeKey: key })).not.toBeNull();
  });

  it("a job with no handler is parked, not looped", async () => {
    await enqueue("unknown", {});
    await q("UPDATE jobs SET queue = 'gone'");
    const w = createWorker({ handlers: { gone2: async () => {} } });
    expect(await w.drain()).toBe(0);
    const w2 = createWorker({ handlers: {} });
    expect(await w2.drain()).toBe(0);
  });

  it("backoff grows exponentially, is capped, and jitters", () => {
    expect(backoffMs(1, () => 0.5)).toBe(5000);
    expect(backoffMs(2, () => 0.5)).toBe(10_000);
    expect(backoffMs(5, () => 0.5)).toBe(80_000);
    expect(backoffMs(30, () => 0.5)).toBe(30 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(4000);
    expect(backoffMs(1, () => 1)).toBe(6000);
  });

  it("reports queue depth", async () => {
    await enqueue("a", {});
    await enqueue("a", {});
    await enqueue("b", {});
    const stats = await queueStats();
    expect(stats.find((s) => s.queue === "a" && s.status === "queued")?.count).toBe(2);
    expect(stats.find((s) => s.queue === "b" && s.status === "queued")?.count).toBe(1);
  });
});

describe("shared rate limiter", () => {
  it("hands out exactly the budget, then says how long to wait", async () => {
    const bucket = uniq("calls");
    for (let i = 0; i < 3; i++) expect(await takeRateSlot(bucket, 3)).toBe(0);
    const wait = await takeRateSlot(bucket, 3);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(61_000);
  });
  it("concurrent takers never exceed the budget", async () => {
    const bucket = uniq("calls");
    const results = await Promise.all(Array.from({ length: 25 }, () => takeRateSlot(bucket, 10)));
    expect(results.filter((r) => r === 0)).toHaveLength(10);
  });
  it("frees a slot once an event is older than a minute", async () => {
    const bucket = uniq("calls");
    expect(await takeRateSlot(bucket, 1)).toBe(0);
    expect(await takeRateSlot(bucket, 1)).toBeGreaterThan(0);
    await q("UPDATE rate_events SET at = now() - interval '61 seconds' WHERE bucket = $1", [bucket]);
    expect(await takeRateSlot(bucket, 1)).toBe(0);
  });
  it("buckets are independent", async () => {
    const a = uniq("a"), b = uniq("b");
    expect(await takeRateSlot(a, 1)).toBe(0);
    expect(await takeRateSlot(b, 1)).toBe(0);
  });
});
