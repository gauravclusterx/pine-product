/**
 * API process. Migrates, makes sure a platform admin exists, starts the HTTP server and (unless
 * INLINE_WORKER=false) a job worker in the same process.
 *
 *   npm start            production (DATABASE_URL required)
 *   npm run dev          development (embedded PostgreSQL when DATABASE_URL is empty)
 */
import { config } from "./config.js";
import { closeDb, initDb, one, q } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { hashPassword, passwordProblem } from "./auth/auth.js";
import { startWorker } from "./jobs.js";
import { log } from "./lib/logger.js";

async function ensurePlatformAdmin(): Promise<void> {
  const email = process.env.PLATFORM_ADMIN_EMAIL || "";
  const password = process.env.PLATFORM_ADMIN_PASSWORD || "";
  if (!email) return;
  const existing = await one("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  if (existing) { await q("UPDATE users SET is_platform_admin = true WHERE id = $1", [existing.id]); return; }
  const problem = passwordProblem(password);
  if (problem) { log.error(`PLATFORM_ADMIN_PASSWORD: ${problem}`); return; }
  await q("INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, 'Platform admin', $2, true)", [email, await hashPassword(password)]);
  log.info({ email }, "platform admin created");
}

async function main() {
  await initDb();
  await migrate();
  await ensurePlatformAdmin();
  const app = buildApp();
  const server = app.listen(config.PORT, () => log.info(`Pine AI listening on http://localhost:${config.PORT}`));
  const worker = config.INLINE_WORKER === "true" ? startWorker({ scheduler: true }) : null;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, "shutting down");
    server.close();
    await worker?.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error({ err }, "failed to start");
  console.error(err);
  process.exit(1);
});
