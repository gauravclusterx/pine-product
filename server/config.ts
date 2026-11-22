/**
 * Runtime configuration. Read once, validated, and frozen — a misconfigured deployment fails at
 * boot with a clear message instead of at the first request that needs the missing value.
 */
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** PostgreSQL connection string. Empty in development = start an embedded PostgreSQL. */
  DATABASE_URL: z.string().default(""),
  /** 32-byte key (64 hex chars) that encrypts stored credentials. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex characters"),
  /** Signs session tokens. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** Public https origin of this deployment — the voice provider calls back into it. */
  PUBLIC_BASE_URL: z.string().default(""),
  RASEN_API_BASE: z.string().default("https://api.rasen.ai/v1"),
  /** Fallback signing secret for call-event webhooks (an org's own secret is tried first). */
  RASEN_WEBHOOK_SECRET: z.string().default(""),
  /** Run the job worker inside the API process (handy locally; use `npm run worker` at scale). */
  INLINE_WORKER: z.enum(["true", "false"]).default("true"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(8),
  /** Optional: an LLM key for QA scoring. Without it QA uses the built-in rules only. */
  OPENAI_API_KEY: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
  /** Google sign-in (the only sign-in method outside tests). */
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  /** Staff domains: any verified Google email on these signs in as platform staff. */
  GOOGLE_ALLOWED_DOMAINS: z.string().default("clusterx.ai,rasen.ai"),
  /** Extra public origins the app is served from (comma separated), e.g. a preview domain. */
  APP_ORIGINS: z.string().default(""),
  /** Where the landing page lead form is stored and emailed (the landing site worker). */
  LANDING_LEAD_URL: z.string().default(""),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}\nSee .env.example.`);
  }
  return Object.freeze(parsed.data);
}

export const config: Config = load();

export const isProd = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";

/** Origin without a trailing slash, or "" when not configured. */
export function publicBaseUrl(): string {
  return config.PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
}

/** The voice provider refuses localhost, private and non-HTTPS callback addresses. */
export function hasPublicBaseUrl(): boolean {
  let u: URL;
  try { u = new URL(publicBaseUrl()); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}
