/**
 * Sign-in and access control.
 *
 * Session: a signed token in an httpOnly cookie. It carries the user id and the user's
 * `token_version`; bumping the version (password change, "sign out everywhere", disabling the
 * user) invalidates every session at once.
 *
 * Tenancy: each request acts on ONE org — the `x-org-id` header, else the user's first
 * membership. The role comes from the membership row; platform staff act as `owner` on any org.
 * Route handlers take the org id from `req.auth.orgId` only, never from the body or the path.
 *
 * CSRF: the cookie is SameSite=Lax, and every state-changing request must also carry the
 * `x-pine-csrf` header, which a cross-site form or image cannot add.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config, isProd } from "../config.js";
import { one, q } from "../db/pool.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export type Role = "owner" | "manager" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, manager: 2, owner: 3 };

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  /** The org this request acts on ("" for a platform admin with no org selected). */
  orgId: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request { auth?: AuthContext; rawBody?: Buffer }
}

export const SESSION_COOKIE = "pine_session";
const SESSION_DAYS = 7;

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** At least 10 characters, with a letter and a digit. Returns a message, or null when acceptable. */
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "Use at most 200 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Use at least one letter and one number.";
  return null;
}

export function signSession(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, config.SESSION_SECRET, { algorithm: "HS256", expiresIn: `${SESSION_DAYS}d` });
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: isProd, path: "/", maxAge: SESSION_DAYS * 86_400_000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" });
}

function readToken(req: Request): string | null {
  const cookie = (req as any).cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

/** Resolve the signed-in user and the org they act on, or throw 401/403. */
export async function authenticate(req: Request): Promise<AuthContext> {
  const token = readToken(req);
  if (!token) throw unauthorized();
  let claims: any;
  try {
    claims = jwt.verify(token, config.SESSION_SECRET, { algorithms: ["HS256"] });
  } catch {
    throw unauthorized("Your session has expired. Sign in again.");
  }
  const user = await one("SELECT id, email, name, is_platform_admin, token_version, disabled FROM users WHERE id = $1", [claims.sub]);
  if (!user || user.disabled || user.token_version !== claims.tv) throw unauthorized("Your session has expired. Sign in again.");

  const wanted = String(req.headers["x-org-id"] || "").trim();
  let orgId = "";
  let role: Role = "viewer";
  if (wanted) {
    if (!/^[0-9a-f-]{36}$/i.test(wanted)) throw forbidden("Unknown workspace.");
    const m = await one("SELECT m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2", [wanted, user.id]);
    if (m) { orgId = wanted; role = m.role; }
    else if (user.is_platform_admin && (await one("SELECT 1 AS ok FROM orgs WHERE id = $1", [wanted]))) { orgId = wanted; role = "owner"; }
    // A wrong org id is a 403, never a silent fall-through to another org.
    else throw forbidden("You do not have access to this workspace.");
  } else {
    const m = await one("SELECT org_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1", [user.id]);
    if (m) { orgId = m.org_id; role = m.role; }
    else if (user.is_platform_admin) role = "owner";
  }
  return { userId: user.id, email: user.email, name: user.name, isPlatformAdmin: user.is_platform_admin, orgId, role };
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Require a signed-in user (and the CSRF header on writes). */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  authenticate(req)
    .then((ctx) => {
      // A bearer token is not sent by browsers automatically, so only cookie sessions need the header.
      const viaCookie = !!(req as any).cookies?.[SESSION_COOKIE];
      if (viaCookie && !SAFE.has(req.method) && !req.headers["x-pine-csrf"]) throw forbidden("Missing request header.");
      req.auth = ctx;
      next();
    })
    .catch(next);
}

/** Require an org context and at least the given role in it. */
export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) return next(unauthorized());
    if (!a.orgId) return next(forbidden("Choose a workspace first."));
    if (RANK[a.role] < RANK[min]) return next(forbidden("Your role does not allow this."));
    next();
  };
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (!req.auth.isPlatformAdmin) return next(forbidden("Platform staff only."));
  next();
}

export async function audit(orgId: string | null, userId: string | null, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await q("INSERT INTO audit_log (org_id, user_id, action, detail) VALUES ($1, $2, $3, $4)", [orgId || null, userId || null, action, JSON.stringify(detail)]);
}
