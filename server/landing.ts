/**
 * The marketing site (pine.rasen.ai) served by the same server as the app:
 *   /, /home-services, /privacy, /terms, /assets/*, /email/*  → files in ./landing
 *   POST /api/lead (and the old /api/join-lead)               → forwarded to LANDING_LEAD_URL
 * The landing pages carry inline scripts and analytics, so they get their own CSP; the app keeps
 * its strict one.
 */
import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { log } from "./lib/logger.js";

const LANDING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://us-assets.i.posthog.com https://us.i.posthog.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com https://www.facebook.com https://connect.facebook.net",
  "frame-src https://www.facebook.com",
  "frame-ancestors 'none'",
].join("; ");

const PAGES: Record<string, string> = {
  "/": "index.html", "/index.html": "index.html",
  "/home-services": "home-services.html", "/home-services.html": "home-services.html",
  "/privacy": "privacy.html", "/privacy.html": "privacy.html",
  "/terms": "terms.html", "/terms.html": "terms.html",
};

export function landingDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "landing");
}

export function mountLanding(app: Express): void {
  const dir = landingDir();
  if (!fs.existsSync(path.join(dir, "index.html"))) return;

  // The lead form: hand the lead to the landing's own handler (it emails and stores it).
  const forward = async (req: Request, res: Response) => {
    if (!config.LANDING_LEAD_URL) return res.status(503).json({ ok: false, reason: "not_configured" });
    try {
      const r = await fetch(config.LANDING_LEAD_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": req.ip || "" },
        body: req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(20_000),
      });
      res.status(r.status).type("application/json").send(await r.text());
    } catch (err) {
      log.warn({ err: (err as Error).message }, "landing lead forward failed");
      res.status(502).json({ ok: false, reason: "store_failed" });
    }
  };
  app.post(["/api/lead", "/api/join-lead"], forward);

  const csp = (_req: Request, res: Response, next: () => void) => { res.setHeader("Content-Security-Policy", LANDING_CSP); next(); };
  app.get(Object.keys(PAGES), csp, (req, res) => res.sendFile(path.join(dir, PAGES[req.path])));
  for (const sub of ["assets", "email"]) app.use(`/${sub}`, csp, express.static(path.join(dir, sub), { index: false, maxAge: "7d" }));
  app.get("/favicon.ico", (_req, res) => res.sendFile(path.join(dir, "favicon.ico")));
}
