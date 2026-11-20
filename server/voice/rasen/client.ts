/**
 * rasen-backend/client.ts
 *
 * Thin, typed HTTP client for the Rasen Developer API (https://api.rasen.ai/v1).
 *
 * Rules of the Rasen API this client enforces so no caller has to remember them:
 *   • Auth is `Authorization: Bearer <workspace key>` (never a cookie).
 *   • Every mutation needs an `Idempotency-Key`. One is generated per logical request and REUSED
 *     across retries, so a retried create/call-start can never dial or create twice.
 *   • Draft/tool/number writes need `If-Match` with the current ETag; the ETag of every answer is
 *     returned to the caller so it can chain the next write.
 *   • `429 rate_limited` / `429 quota_exceeded` / `503` carry `Retry-After`: wait, then resend the
 *     SAME request with the SAME Idempotency-Key.
 *   • Errors are `{ error: { code, message, details, request_id, retry } }`. Branch on `code`.
 *
 * The API key is never logged, and never placed in an error message.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { randomUUID } from "crypto";

export function rasenApiBase(): string {
  return (process.env.RASEN_API_BASE || "https://api.rasen.ai/v1").replace(/\/+$/, "");
}

export class RasenError extends Error {
  status: number;
  code: string;
  details: Record<string, any>;
  requestId: string | null;
  retry: string | null;
  retryAfterSeconds: number | null;

  constructor(init: {
    message: string;
    status: number;
    code: string;
    details?: Record<string, any>;
    requestId?: string | null;
    retry?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = "RasenError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details || {};
    this.requestId = init.requestId ?? null;
    this.retry = init.retry ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export interface RasenRequestOptions {
  query?: Record<string, any>;
  body?: any;
  /** Current ETag of the resource being changed (sent as `If-Match`). */
  ifMatch?: string | null;
  /** Supply to make a caller-level retry replay the same operation. Auto-generated for mutations. */
  idempotencyKey?: string;
  /** Extra headers (e.g. `Range` for a recording). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** `stream` for recordings, `arraybuffer` for exports. Default JSON. */
  responseType?: "json" | "stream" | "arraybuffer";
  /** Max automatic attempts for retryable failures (default 3). */
  maxAttempts?: number;
  /** Longest `Retry-After` we are willing to sleep for inline (seconds, default 20). */
  maxRetryAfterSeconds?: number;
  /** Longest we queue for a slot in our own per-key rate budget (ms, default 90000). */
  maxQueueMs?: number;
}

export interface RasenResponse<T = any> {
  data: T;
  /** ETag of the answer (quoted, exactly as sent) — the revision the next `If-Match` needs. */
  etag: string | null;
  status: number;
  headers: Record<string, any>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Reads that are POSTs: they take no Idempotency-Key. */
const READ_POSTS = [/^\/calls\/search$/, /^\/usage\/query$/, /\/draft\/validate$/, /\/tools\/validate$/, /^\/campaigns\/recipients\/check$/];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Client-side rate limiting ───────────────────────────────────────────────
// Rasen's ceilings are PER KEY, per minute (docs: concepts/rate-limits):
//   reads 60 · call starts 10 · authoring writes 30 · ingestion/discovery/provisioning 5
// A refused request still costs a round trip and, worse, a burst (the poller sweeping a tenant,
// a campaign launching) would starve interactive requests of the same tenant. So we pace
// ourselves just under each ceiling and queue instead of colliding with a 429.
// The limiter is per process and per key; a 429 that still arrives (another process, another
// integration on the same key) is handled by the Retry-After loop below.

export type RateClass = "read" | "call_start" | "write" | "ingest";

const RATE_BUDGET: Record<RateClass, number> = { read: 54, call_start: 9, write: 27, ingest: 4 };
const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

export function rateClassOf(method: string, path: string): RateClass {
  if (method === "GET") return "read";
  if (method === "POST" && READ_POSTS.some((re) => re.test(path))) return "read";
  if (method === "POST" && (/^\/calls$/.test(path) || /^\/agent-sessions$/.test(path))) return "call_start";
  if (/\/upload$|\/discover$|\/provision$|\/reingest$|\/import$|^\/campaigns\/upload$/.test(path)) return "ingest";
  return "write";
}

function keyBucket(apiKey: string, cls: RateClass): string {
  // Key the bucket by a short non-reversible fingerprint — never keep the secret as a map key
  // that could end up in a heap dump label or a debug print.
  let h = 2166136261;
  for (let i = 0; i < apiKey.length; i++) { h ^= apiKey.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${apiKey.length}:${cls}`;
}

/**
 * Wait for a slot in the caller's per-key budget. Resolves once the request may be sent.
 * Throws a local `rate_limited` RasenError when the wait would exceed `maxQueueMs`, so an
 * interactive request fails fast with a clear reason instead of hanging.
 */
export async function acquireRateSlot(apiKey: string, cls: RateClass, maxQueueMs = 90_000): Promise<void> {
  const bucket = keyBucket(apiKey, cls);
  const budget = RATE_BUDGET[cls];
  const deadline = Date.now() + maxQueueMs;
  for (;;) {
    const now = Date.now();
    const stamps = (windows.get(bucket) || []).filter((t) => now - t < WINDOW_MS);
    if (stamps.length < budget) {
      stamps.push(now);
      windows.set(bucket, stamps);
      return;
    }
    windows.set(bucket, stamps);
    const waitMs = stamps[0] + WINDOW_MS - now + 25;
    if (now + waitMs > deadline) {
      throw new RasenError({
        message: "Voice provider rate limit reached for this workspace key. Try again in a moment.",
        status: 429,
        code: "rate_limited",
        details: { scope: "key", limit: budget, window_s: 60, local: true, class: cls },
        retry: "retry_after",
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      });
    }
    await sleep(waitMs);
  }
}

/** Test hook: forget every rate window. */
export function resetRateLimiter(): void {
  windows.clear();
}

function parseRetryAfter(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(String(v));
  if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

function toRasenError(status: number, data: any, headers: Record<string, any>): RasenError {
  const e = data?.error || {};
  return new RasenError({
    message: e.message || `Rasen API request failed (HTTP ${status})`,
    status,
    code: e.code || `http_${status}`,
    details: e.details,
    requestId: e.request_id || headers?.["x-request-id"] || null,
    retry: e.retry || null,
    retryAfterSeconds: parseRetryAfter(headers?.["retry-after"]),
  });
}

/**
 * Send one Rasen API request. `apiKey` is the plaintext workspace key.
 * Throws `RasenError` for any non-2xx answer.
 */
export async function rasenRequest<T = any>(
  apiKey: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  opts: RasenRequestOptions = {}
): Promise<RasenResponse<T>> {
  if (!apiKey) {
    throw new RasenError({ message: "Voice API key not configured", status: 401, code: "unauthenticated" });
  }
  const isReadPost = method === "POST" && READ_POSTS.some((re) => re.test(path));
  const mutating = MUTATING.has(method) && !isReadPost;
  const idempotencyKey = mutating ? opts.idempotencyKey || randomUUID() : undefined;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...(opts.headers || {}),
  };
  if (opts.body !== undefined && !(opts.body instanceof Buffer) && !isFormData(opts.body)) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;

  const config: AxiosRequestConfig = {
    baseURL: rasenApiBase(),
    url: path,
    method,
    headers,
    params: cleanQuery(opts.query),
    data: opts.body,
    timeout: opts.timeoutMs ?? 30_000,
    responseType: opts.responseType || "json",
    // Never follow a redirect with the bearer attached to another host.
    maxRedirects: 0,
    validateStatus: () => true,
    paramsSerializer: { indexes: null }, // repeat keys: state=a&state=b
  };

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxWait = opts.maxRetryAfterSeconds ?? 20;
  let lastErr: any = null;

  const rateClass = rateClassOf(method, path);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: AxiosResponse;
    await acquireRateSlot(apiKey, rateClass, opts.maxQueueMs);
    try {
      res = await axios.request(config);
    } catch (err: any) {
      // Network failure / timeout. Safe to resend: reads are safe, and a mutation replays under
      // the same Idempotency-Key.
      lastErr = new RasenError({
        message: `Rasen API unreachable: ${err?.code || err?.message || "network error"}`,
        status: 0,
        code: "network_error",
      });
      if (attempt < maxAttempts) { await sleep(400 * attempt); continue; }
      throw lastErr;
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        data: res.data as T,
        etag: (res.headers?.etag as string) || null,
        status: res.status,
        headers: res.headers as any,
      };
    }

    let payload = res.data;
    if (config.responseType !== "json") payload = await readErrorPayload(payload);
    const error = toRasenError(res.status, payload, res.headers as any);
    lastErr = error;

    const retryable =
      error.status === 429 ||
      error.status === 503 ||
      error.status === 502 ||
      error.status === 504 ||
      error.code === "idempotency_in_progress";
    if (!retryable || attempt >= maxAttempts) throw error;

    const wait = error.retryAfterSeconds ?? attempt; // seconds
    if (wait > maxWait) throw error; // caller decides (queue it), never block a request for minutes
    await sleep(Math.max(250, wait * 1000));
  }
  throw lastErr;
}

function cleanQuery(q?: Record<string, any>): Record<string, any> | undefined {
  if (!q) return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function isFormData(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.getHeaders === "function";
}

async function readErrorPayload(payload: any): Promise<any> {
  try {
    if (payload == null) return null;
    if (Buffer.isBuffer(payload)) return JSON.parse(payload.toString("utf8"));
    if (payload instanceof ArrayBuffer) return JSON.parse(Buffer.from(payload).toString("utf8"));
    if (typeof payload.on === "function") {
      const chunks: Buffer[] = [];
      for await (const c of payload) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Read every page of a Rasen list endpoint (`{ items, next_cursor }`), bounded by `maxItems`.
 * Rasen pages are capped at 200 items.
 */
export async function rasenListAll<T = any>(
  apiKey: string,
  path: string,
  query: Record<string, any> = {},
  maxItems = 1000
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 200));
  // Hard page cap so a misbehaving cursor can never loop forever.
  for (let page = 0; page < 200; page++) {
    const res: RasenResponse<{ items: T[]; next_cursor: string | null }> = await rasenRequest(apiKey, "GET", path, {
      query: { ...query, limit, ...(cursor ? { cursor } : {}) },
    });
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    out.push(...items);
    cursor = res.data?.next_cursor || null;
    if (!cursor || out.length >= maxItems) break;
  }
  return out.slice(0, maxItems);
}
