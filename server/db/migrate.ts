/**
 * Forward-only SQL migrations: every `*.sql` file in ./migrations, applied once, in name order,
 * each inside its own transaction. An advisory lock makes concurrent boots (several API or worker
 * processes starting together) apply them exactly once.
 *
 *   npm run db:migrate
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { closeDb, getPool, initDb } from "./pool.js";
import { log } from "../lib/logger.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_KEY = 724_319_001; // arbitrary, fixed

export async function migrate(): Promise<string[]> {
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } catch { /* connection closed */ }
    client.release();
  }
  if (applied.length) log.info({ applied }, "migrations applied");
  return applied;
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initDb()
    .then(migrate)
    .then((a) => { console.log(a.length ? `applied: ${a.join(", ")}` : "up to date"); return closeDb(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
