/**
 * Shared test helpers: a migrated database with empty tables, and factories for the rows most
 * tests need (an org, a signed-in user).
 */
import { initDb, q } from "../server/db/pool.js";
import { migrate } from "../server/db/migrate.js";

let ready = false;

/** Call in beforeAll/beforeEach: migrates once, then empties every table. */
export async function resetDb(): Promise<void> {
  if (!ready) {
    await initDb();
    await migrate();
    ready = true;
  }
  const tables = await q<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
  );
  if (tables.length) {
    // Fire-and-forget work of the previous test (a confirmation SMS, a team alert) may still be
    // writing; TRUNCATE can then deadlock with it. Retry briefly instead of failing the test.
    for (let attempt = 1; ; attempt++) {
      try {
        await q(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
        break;
      } catch (err: any) {
        if (err?.code !== "40P01" || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  }
}

let seq = 0;
export const uniq = (prefix = "x") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function makeOrg(over: Partial<{ name: string; slug: string; timezone: string; industry: string; settings: Record<string, unknown>; rate: number }> = {}) {
  const slug = over.slug || uniq("org");
  const rows = await q(
    "INSERT INTO orgs (name, slug, timezone, industry, settings, rate_cents_per_minute, wallet_voice, wallet_chat) VALUES ($1, $2, $3, $4, $5, $6, 1000, 1000) RETURNING *",
    [over.name || "Acme Heating & Air", slug, over.timezone || "America/New_York", over.industry || "hvac", JSON.stringify(over.settings || {}), over.rate ?? 25]
  );
  return rows[0];
}
