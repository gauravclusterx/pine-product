/**
 * rasen-backend/webhook.ts
 *
 * Verification of Rasen webhook deliveries (Standard Webhooks scheme).
 *
 *   signed content = `${webhook-id}.${webhook-timestamp}.${raw body bytes}`
 *   key            = base64-decoded part of the secret after `whsec_` (32 bytes)
 *   algorithm      = HMAC-SHA256, sent as `webhook-signature: v1,<base64>` — one OR two
 *                    space-separated values (two during a secret-rotation grace period).
 *
 * A delivery is rejected when: a header is missing, the timestamp is more than 5 minutes away
 * from now (replay protection), or no signature matches any configured secret.
 * Comparison is constant-time.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerifyFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "timestamp_out_of_tolerance"
  | "no_secret"
  | "bad_secret"
  | "signature_mismatch";

export interface WebhookVerifyResult {
  ok: boolean;
  reason?: WebhookVerifyFailure;
  /** Index of the secret (in the `secrets` array) that verified the delivery. */
  matchedSecretIndex?: number;
}

function header(headers: Record<string, any>, name: string): string {
  let v = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (v === undefined && headers) {
    // Node lower-cases incoming header names, but be exact about it rather than assume the caller did.
    const want = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === want) { v = headers[k]; break; }
    }
  }
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

/** Decode a `whsec_…` secret to its raw HMAC key. Returns null when malformed. */
export function decodeWebhookSecret(secret: string): Buffer | null {
  const s = String(secret || "").trim();
  if (!s.startsWith("whsec_")) return null;
  const b64 = s.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, "base64");
  return key.length >= 16 ? key : null;
}

/** Compute the `v1,<base64>` signature for a delivery (exported for tests and tooling). */
export function signWebhook(secret: string, id: string, timestamp: string, rawBody: Buffer | string): string {
  const key = decodeWebhookSecret(secret);
  if (!key) throw new Error("invalid webhook secret");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const mac = createHmac("sha256", key);
  mac.update(`${id}.${timestamp}.`);
  mac.update(body);
  return `v1,${mac.digest("base64")}`;
}

/**
 * Verify one delivery against one or more candidate secrets.
 * `rawBody` MUST be the exact bytes received (never a re-serialised JSON object).
 */
export function verifyWebhookSignature(
  headers: Record<string, any>,
  rawBody: Buffer | string,
  secrets: Array<string | null | undefined>,
  nowMs: number = Date.now()
): WebhookVerifyResult {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatureHeader = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: "missing_headers" };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const candidates = secrets.filter((s): s is string => !!s && !!String(s).trim());
  if (!candidates.length) return { ok: false, reason: "no_secret" };

  const offered = signatureHeader
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1,"))
    .map((p) => p.slice(3));
  if (!offered.length) return { ok: false, reason: "signature_mismatch" };

  let sawValidSecret = false;
  for (let i = 0; i < candidates.length; i++) {
    if (!decodeWebhookSecret(candidates[i])) continue;
    sawValidSecret = true;
    const expected = Buffer.from(signWebhook(candidates[i], id, timestamp, rawBody).slice(3), "base64");
    for (const sig of offered) {
      let got: Buffer;
      try { got = Buffer.from(sig, "base64"); } catch { continue; }
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        return { ok: true, matchedSecretIndex: i };
      }
    }
  }
  return { ok: false, reason: sawValidSecret ? "signature_mismatch" : "bad_secret" };
}

// ─── Event envelope ───────────────────────────────────────────────────────────

export type RasenWebhookEventType = "call.completed" | "call.failed" | "call.analyzed" | "webhook.test" | string;

export interface RasenWebhookEnvelope {
  id: string;
  type: RasenWebhookEventType;
  created_at: string;
  workspace_id: string;
  api_version: string;
  data: any;
}

/** Parse + minimally validate an event body. Returns null for anything that is not an envelope. */
export function parseWebhookEnvelope(rawBody: Buffer | string): RasenWebhookEnvelope | null {
  try {
    const obj = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.id !== "string" || typeof obj.type !== "string") return null;
    return obj as RasenWebhookEnvelope;
  } catch {
    return null;
  }
}

/**
 * The call id an event is about. A body over 1 MiB arrives in the reduced form
 * (`{ call_id, truncated: true }`), in which case the caller must read the call from the API.
 */
export function eventCallId(evt: RasenWebhookEnvelope): { callId: string | null; reduced: boolean } {
  const d = evt?.data || {};
  if (d.truncated === true && typeof d.call_id === "string") return { callId: d.call_id, reduced: true };
  const id = d.call?.id;
  return { callId: typeof id === "string" ? id : null, reduced: false };
}
