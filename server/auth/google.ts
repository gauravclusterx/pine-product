/**
 * "Sign in with Google" — the only way to sign in (password sign-in is test-only).
 *
 * Who may sign in: see decideSignIn. Admins = PLATFORM_ADMIN_EMAILS; customers sign up from the
 * allowed domains (or were added by an admin) and each customer gets their own workspace.
 *
 * The flow is the plain OAuth 2.0 authorization-code flow: a random `state` in a short-lived
 * httpOnly cookie guards the callback, the code is exchanged server-side, and only a verified
 * Google email is trusted.
 */
import crypto from "node:crypto";
import type { Request } from "express";
import { config, isProd, publicBaseUrl } from "../config.js";

export const STATE_COOKIE = "pine_oauth_state";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const googleConfigured = () => !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

export function allowedDomains(): string[] {
  return config.GOOGLE_ALLOWED_DOMAINS.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}

export const emailDomain = (email: string) => email.trim().toLowerCase().split("@").pop() || "";

export function adminEmails(): string[] {
  return config.PLATFORM_ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export type SignInDecision =
  | { ok: true; create: boolean; admin: boolean }
  | { ok: false; reason: "not_verified" | "not_allowed" | "disabled" };

/**
 * Pure policy: may this Google identity sign in, and as what.
 *  - Platform admins are the listed emails only.
 *  - Anyone already added (a client owner or team member) signs in, whatever the domain.
 *  - A new person on an allowed domain signs up as a customer with their own workspace.
 *  - Nobody else.
 */
export function decideSignIn(
  g: { email: string; emailVerified: boolean },
  existing: { disabled: boolean } | null,
  domains: string[] = allowedDomains(),
  admins: string[] = adminEmails(),
): SignInDecision {
  if (!g.email || !g.emailVerified) return { ok: false, reason: "not_verified" };
  const email = g.email.trim().toLowerCase();
  const admin = admins.includes(email);
  if (existing) return existing.disabled ? { ok: false, reason: "disabled" } : { ok: true, create: false, admin };
  if (admin || domains.includes(emailDomain(email))) return { ok: true, create: true, admin };
  return { ok: false, reason: "not_allowed" };
}

/**
 * The public origin this request came through (the app may sit behind Vercel and nginx).
 * Only origins on the allow-list are used, so a forged Host header cannot redirect the flow.
 */
export function requestOrigin(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const origin = `${proto}://${host}`.toLowerCase();
  return appOrigins().includes(origin) ? origin : appOrigins()[0];
}

export function appOrigins(): string[] {
  const list = config.APP_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  const base = publicBaseUrl().toLowerCase();
  if (base && !list.includes(base)) list.unshift(base);
  if (!isProd) list.push(`http://localhost:${config.PORT}`);
  return list.length ? list : [`http://localhost:${config.PORT}`];
}

export const redirectUri = (origin: string) => `${origin}/api/auth/google/callback`;

export function newState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function authUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${p}`;
}

/** Exchange the code and read the verified Google profile. */
export async function fetchGoogleProfile(code: string, origin: string): Promise<{ email: string; emailVerified: boolean; name: string }> {
  const tok = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin), grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tok.ok) throw new Error(`Google token exchange failed (${tok.status})`);
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) throw new Error("Google returned no access token");
  const info = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!info.ok) throw new Error(`Google profile request failed (${info.status})`);
  const u = (await info.json()) as { email?: string; email_verified?: boolean | string; name?: string };
  return { email: String(u.email || "").toLowerCase(), emailVerified: u.email_verified === true || u.email_verified === "true", name: String(u.name || "") };
}
