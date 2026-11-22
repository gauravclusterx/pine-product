/** The Express app (no listening, no database start) — so tests can mount it. */
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { pinoHttp } from "pino-http";
import { errorMiddleware } from "./http.js";
import { publicRouter } from "./routes/public.js";
import { apiRouter } from "./routes/api.js";
import { getPool } from "./db/pool.js";
import { queueStats } from "./queue/queue.js";
import { log } from "./lib/logger.js";
import { isTest } from "./config.js";
import { mountLanding } from "./landing.js";

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"], "img-src": ["'self'", "data:", "https:"], "media-src": ["'self'", "blob:"],
        "script-src": ["'self'", "https://checkout.razorpay.com"], "frame-src": ["https://api.razorpay.com", "https://checkout.razorpay.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], "font-src": ["'self'", "https://fonts.gstatic.com"],
        "connect-src": ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com"], "frame-ancestors": ["'none'"],
      },
    },
  }));
  if (!isTest) app.use(pinoHttp({ logger: log, autoLogging: { ignore: (req) => req.url === "/healthz" } }));
  // Raw bytes are kept for signature checks (voice provider, Meta).
  // Knowledge documents (≤ 20 MB, sent base64) need a larger body than everything else.
  app.use(/^\/api\/agents\/[^/]+\/knowledge\/upload$/, express.json({ limit: "30mb" }));
  app.use(express.json({ limit: "2mb", verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());

  app.get("/healthz", async (_req, res) => {
    try {
      await getPool().query("SELECT 1");
      const queues = await queueStats();
      const backlog = queues.filter((x) => x.status === "queued").reduce((n, x) => n + x.count, 0);
      res.json({ status: "ok", db: "up", queueBacklog: backlog });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });

  // The marketing site and its lead form come first; the app owns everything else.
  mountLanding(app);

  app.use("/api", publicRouter);
  app.use("/api", apiRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: { code: "not_found", message: "No such endpoint." } }));

  // The built web app (npm run build). In development Vite serves it instead.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  // The build writes the app page as app.html; dist/index.html is the landing page.
  const page = ["app.html", "index.html"].map((f) => path.join(dist, f)).find((f) => fs.existsSync(f));
  if (page) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(page));
  }
  app.use(errorMiddleware);
  return app;
}
