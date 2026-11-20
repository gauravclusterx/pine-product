/**
 * Durable job queue on PostgreSQL.
 *
 * Why not an in-memory queue: work here must survive a deploy or a crash (a lead that arrived a
 * second before a restart still has to be called). Why not a broker: one fewer system to run, and
 * a job can be enqueued in the SAME transaction as the row that caused it, so "lead saved but
 * call never queued" cannot happen.
 *
 * Guarantees
 *  - A job is claimed by exactly one worker (`FOR UPDATE SKIP LOCKED`), however many processes run.
 *  - At-least-once: a worker that dies mid-job loses its lock after `VISIBILITY_MS` and the job
 *    runs again. Handlers must therefore be idempotent (they are: every external effect carries
 *    an idempotency key).
 *  - Failures retry with exponential backoff + jitter, up to `max_attempts`, then the job is
 *    parked as `dead` with its last error for a human to look at.
 *  - `dedupeKey`: at most one live job per key — enqueueing the same work twice is a no-op.
 */
import os from "os";
import { randomUUID } from "crypto";
import { q, tx, Q, isUniqueViolation } from "../db/pool.js";
import { log } from "../lib/logger.js";

export interface Job<P = any> {
  id: number;
  queue: string;
  orgId: string | null;
  payload: P;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  orgId?: string | null;
  /** Earliest time to run. Default: now. */
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
  /** Enqueue inside a caller's transaction. */
  q?: Q;
}

/** How long a claimed job may run before another worker may take it over. */
export const VISIBILITY_MS = 5 * 60_000;

/** Enqueue a job. Returns its id, or null when a live job with the same dedupeKey already exists. */
export async function enqueue(queue: string, payload: unknown, opts: EnqueueOptions = {}): Promise<number | null> {
  const run = opts.q || q;
  try {
    const rows = await run<{ id: number }>(
      `INSERT INTO jobs (queue, org_id, payload, run_at, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [queue, opts.orgId ?? null, JSON.stringify(payload ?? {}), opts.runAt ?? new Date(), opts.maxAttempts ?? 8, opts.dedupeKey ?? null]
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** Retry delay for the n-th failure: 5s, 10s, 20s, … capped at 30 min, ±20% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Claim up to `limit` runnable jobs of the given queues. */
export async function claim(queues: string[], limit: number, workerId: string): Promise<Job[]> {
  if (!queues.length || limit <= 0) return [];
  const rows = await q(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $3, attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs
       WHERE queue = ANY($1)
         AND ((status = 'queued' AND run_at <= now())
           OR (status = 'running' AND locked_at < now() - ($4::int * interval '1 millisecond')))
       ORDER BY run_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, queue, org_id, payload, attempts, max_attempts`,
    [queues, limit, workerId, VISIBILITY_MS]
  );
  return rows.map((r) => ({ id: r.id, queue: r.queue, orgId: r.org_id, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
}

export async function complete(jobId: number): Promise<void> {
  await q("UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL WHERE id = $1", [jobId]);
}

/** Record a failure: retry later, or park the job as dead after its last attempt. */
export async function fail(job: Job, err: unknown, opts: { retryAfterMs?: number } = {}): Promise<"retry" | "dead"> {
  const message = String((err as any)?.message || err).slice(0, 2000);
  if (job.attempts >= job.maxAttempts) {
    await q("UPDATE jobs SET status = 'dead', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = $2 WHERE id = $1", [job.id, message]);
    return "dead";
  }
  const delay = opts.retryAfterMs ?? backoffMs(job.attempts);
  await q(
    "UPDATE jobs SET status = 'queued', run_at = now() + ($2::int * interval '1 millisecond'), locked_at = NULL, locked_by = NULL, last_error = $3 WHERE id = $1",
    [job.id, Math.max(0, Math.round(delay)), message]
  );
  return "retry";
}

/** Put a job back without counting an attempt (used when we are throttling ourselves). */
export async function defer(job: Job, delayMs: number): Promise<void> {
  await q(
    "UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0), run_at = now() + ($2::int * interval '1 millisecond'), locked_at = NULL, locked_by = NULL WHERE id = $1",
    [job.id, Math.max(0, Math.round(delayMs))]
  );
}

/** Thrown by a handler to say "not now": the job is deferred and the attempt is not counted. */
export class DeferJob extends Error {
  delayMs: number;
  constructor(delayMs: number, reason = "deferred") {
    super(reason);
    this.name = "DeferJob";
    this.delayMs = delayMs;
  }
}

/** Thrown by a handler when retrying cannot help (bad input): the job is parked at once. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export type Handler = (job: Job) => Promise<void>;

export interface WorkerOptions {
  handlers: Record<string, Handler>;
  concurrency?: number;
  pollMs?: number;
}

export interface Worker {
  /** Process every currently runnable job, then return. For tests and one-shot runs. */
  drain: () => Promise<number>;
  start: () => void;
  stop: () => Promise<void>;
}

async function runOne(job: Job, handlers: Record<string, Handler>): Promise<void> {
  const handler = handlers[job.queue];
  if (!handler) {
    await q("UPDATE jobs SET status = 'dead', finished_at = now(), last_error = $2 WHERE id = $1", [job.id, `no handler for queue "${job.queue}"`]);
    return;
  }
  try {
    await handler(job);
    await complete(job.id);
  } catch (err) {
    if (err instanceof DeferJob) { await defer(job, err.delayMs); return; }
    if (err instanceof PermanentJobError) {
      await q("UPDATE jobs SET status = 'dead', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = $2 WHERE id = $1", [job.id, err.message.slice(0, 2000)]);
      log.warn({ jobId: job.id, queue: job.queue, err: err.message }, "job failed permanently");
      return;
    }
    const outcome = await fail(job, err);
    log.warn({ jobId: job.id, queue: job.queue, attempt: job.attempts, outcome, err: String((err as any)?.message || err) }, "job failed");
  }
}

export function createWorker(opts: WorkerOptions): Worker {
  const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const queues = Object.keys(opts.handlers);
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const pollMs = opts.pollMs ?? 1000;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = 0;
  let idle: Promise<void> = Promise.resolve();

  const tick = async (): Promise<number> => {
    const room = concurrency - inFlight;
    if (room <= 0) return 0;
    const jobs = await claim(queues, room, workerId);
    inFlight += jobs.length;
    await Promise.all(jobs.map((j) => runOne(j, opts.handlers).finally(() => { inFlight--; })));
    return jobs.length;
  };

  const loop = async () => {
    if (!running) return;
    let n = 0;
    try { n = await tick(); } catch (err) { log.error({ err }, "queue tick failed"); }
    if (!running) return;
    // Busy → look again at once; idle → wait a poll interval.
    timer = setTimeout(() => { idle = loop(); }, n > 0 ? 0 : pollMs);
  };

  return {
    drain: async () => {
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        const n = await tick();
        if (!n) break;
        total += n;
      }
      return total;
    },
    start: () => {
      if (running) return;
      running = true;
      idle = loop();
    },
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      await idle.catch(() => {});
      // Let jobs that are already running finish (bounded), so a deploy never cuts a call start in half.
      for (let i = 0; i < 300 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 100));
    },
  };
}

// ── rate limiting across processes ────────────────────────────────────────────

/**
 * Take one slot of a sliding one-minute budget shared by every process. Returns 0 when the slot
 * was taken, otherwise the milliseconds until one frees up. Used for the voice provider's
 * call-start limit (10 per minute per key): a burst of leads waits in the queue instead of being
 * refused by the provider.
 */
export async function takeRateSlot(bucket: string, limitPerMinute: number): Promise<number> {
  return tx(async (t) => {
    // Serialise takers of this bucket so two processes cannot both see "one slot left".
    await t("SELECT pg_advisory_xact_lock(hashtext($1))", [bucket]);
    await t("DELETE FROM rate_events WHERE bucket = $1 AND at < now() - interval '60 seconds'", [bucket]);
    const rows = await t<{ n: number; oldest: Date | null }>("SELECT count(*)::int AS n, min(at) AS oldest FROM rate_events WHERE bucket = $1", [bucket]);
    const { n, oldest } = rows[0];
    if (n < limitPerMinute) {
      await t("INSERT INTO rate_events (bucket) VALUES ($1)", [bucket]);
      return 0;
    }
    const waitMs = oldest ? Math.max(250, new Date(oldest).getTime() + 60_000 - Date.now() + 50) : 1000;
    return waitMs;
  });
}

/** Queue depth by queue and status — for the health endpoint and the admin screen. */
export async function queueStats(): Promise<Array<{ queue: string; status: string; count: number; oldest: Date | null }>> {
  return q("SELECT queue, status, count(*)::int AS count, min(run_at) AS oldest FROM jobs WHERE status IN ('queued', 'running', 'dead') GROUP BY queue, status ORDER BY queue, status");
}
