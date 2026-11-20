/**
 * PostgreSQL access.
 *
 * `q` runs one statement on the pool. `tx` runs a function inside a transaction and gives it a
 * client-bound `q`; it commits on return and rolls back on throw. Nothing else in the codebase
 * holds a client, so a connection can never leak out of a request.
 */
import pg from "pg";
import { config, isTest } from "../config.js";
import { log } from "../lib/logger.js";

// int8 (bigserial ids, counts) → number. Ids here never approach 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric → number (sums of integers come back as numeric).
pg.types.setTypeParser(1700, (v) => Number(v));

let pool: pg.Pool | null = null;
let stopEmbedded: (() => Promise<void>) | null = null;

export type Row = Record<string, any>;
export type Q = <T extends Row = Row>(text: string, params?: unknown[]) => Promise<T[]>;

/** Connect (once). With no DATABASE_URL outside production, an embedded PostgreSQL is started. */
export async function initDb(): Promise<pg.Pool> {
  if (pool) return pool;
  let url = process.env.DATABASE_URL || config.DATABASE_URL;
  if (!url) {
    if (config.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    const embedded = await import("./embedded.js");
    const started = await embedded.startEmbeddedPostgres();
    url = started.url;
    stopEmbedded = started.stop;
    log.info("using embedded PostgreSQL (development) at %s", started.dataDir);
  }
  pool = new pg.Pool({
    connectionString: url,
    max: isTest ? 5 : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed PostgreSQL (RDS, Cloud SQL, Neon, …) requires TLS; a local server does not offer it.
    ssl: /sslmode=require|\.rds\.amazonaws\.com|neon\.tech|supabase\.co/.test(url) ? { rejectUnauthorized: true } : undefined,
  });
  pool.on("error", (err) => log.error({ err }, "idle database client error"));
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("database not initialised — call initDb() first");
  return pool;
}

export const q: Q = async (text, params) => {
  const res = await getPool().query(text, params as any[]);
  return res.rows as any[];
};

/** First row, or null. */
export async function one<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run `fn` in a transaction. Commit on return, roll back on throw. */
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const bound: Q = async (text, params) => (await client.query(text, params as any[])).rows as any[];
  try {
    await client.query("BEGIN");
    const out = await fn(bound);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* the connection is gone; the server rolls back */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
  if (stopEmbedded) { await stopEmbedded(); stopEmbedded = null; }
}

/** True for a unique-constraint violation (optionally of one named constraint). */
export function isUniqueViolation(err: any, constraint?: string): boolean {
  return err?.code === "23505" && (!constraint || err?.constraint === constraint);
}
