/**
 * Test run setup: one real PostgreSQL (embedded, throwaway data directory) for the whole run.
 * Its URL is handed to the test files through the environment; each file migrates on first use
 * and truncates its tables between tests (tests/helpers.ts).
 */
import { startEmbeddedPostgres } from "../server/db/embedded.js";

let stop: (() => Promise<void>) | null = null;

export async function setup() {
  process.env.NODE_ENV = "test";
  const pg = await startEmbeddedPostgres({ persistent: false, database: "pine_test" });
  stop = pg.stop;
  process.env.DATABASE_URL = pg.url;
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.SESSION_SECRET = "test-session-secret-test-session-secret-0000";
  process.env.PUBLIC_BASE_URL = "https://pine.test";
  process.env.RASEN_WEBHOOK_SECRET = "whsec_" + Buffer.alloc(32, 3).toString("base64");
  process.env.INLINE_WORKER = "false";
}

export async function teardown() {
  if (stop) await stop();
}
