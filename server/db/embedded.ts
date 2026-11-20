/**
 * A real PostgreSQL started from npm binaries — for local development and for the test suite.
 * No Docker and no system install needed. Production always uses DATABASE_URL.
 */
import EmbeddedPostgres from "embedded-postgres";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface EmbeddedHandle { url: string; dataDir: string; stop: () => Promise<void> }

/**
 * @param opts.persistent keep the data directory between runs (development). Tests pass false
 *        and get a throwaway cluster in the OS temp directory.
 */
export async function startEmbeddedPostgres(opts: { persistent?: boolean; database?: string } = {}): Promise<EmbeddedHandle> {
  const persistent = opts.persistent ?? true;
  const database = opts.database || "pine";
  const dataDir = persistent
    ? path.resolve(process.cwd(), ".pgdata")
    : fs.mkdtempSync(path.join(os.tmpdir(), "pine-pg-"));
  const port = await freePort();
  const password = "pine-local";
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "pine",
    password,
    port,
    persistent,
    // Without this, initdb on Windows takes the OS code page (WIN1252) and rejects UTF-8 text.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });

  const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(database);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await pg.stop(); } catch { /* already down */ }
    if (!persistent) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
  return { url: `postgres://pine:${password}@127.0.0.1:${port}/${database}`, dataDir, stop };
}
