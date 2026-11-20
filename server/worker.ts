/**
 * Worker process: background jobs only. Run as many as the load needs — jobs are claimed with
 * SKIP LOCKED, so workers never collide. One of them should run the scheduler (WORKER_SCHEDULER).
 *
 *   npm run worker
 */
import { initDb, closeDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { startWorker } from "./jobs.js";
import { log } from "./lib/logger.js";

async function main() {
  await initDb();
  await migrate();
  const worker = startWorker({ scheduler: process.env.WORKER_SCHEDULER !== "false" });
  log.info("worker started");
  const stop = async () => { await worker.stop(); await closeDb(); process.exit(0); };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

main().catch((err) => { console.error(err); process.exit(1); });
