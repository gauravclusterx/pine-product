/**
 * rasen-backend/mappers.ts
 *
 * Pure functions that normalise Rasen API objects into the internal structures the rest of the
 * app consumes. The poller, the routes and the frontend never learn Rasen's wire format — they
 * keep reading `telephony_data`, `conversation_time`, `ended_reason`, etc.
 *
 * Rasen reference shapes (https://docs.rasen.ai, OpenAPI components):
 *   Agent       → { id, name, description, state: draft|live|paused|archived, live_version_id, resource_key }
 *   PhoneNumber → { id, number, label, provider, supports_inbound, supports_outbound,
 *                   inbound_agent_id, inbound_setup, outbound_agent_ids, outbound_primary_agent_ids }
 *   Call        → { id, agent_id, state, terminal, direction, created_at, ended_at, end_reason,
 *                   dial_outcome, dial_sip_code, metadata, transcript_state, extraction_state,
 *                   summary_state, from_number_id, effective_variables[] }
 *   Transcript  → { items: [{ index, speaker, text, start_ms, end_ms }] }
 *
 * What Rasen does NOT put on a call, and where we get it instead:
 *   • The customer's phone number — never on the Call or in a webhook body. For OUTBOUND calls we
 *     write it into `metadata.to_number` when we place the call. For INBOUND calls it comes from
 *     the before-call tool (`system__caller_id`) and is attached by the caller of these mappers.
 *   • A price — Rasen reports quantities only. Billing is call minutes × the tenant's rate.
 */

// ─── Agent → internal agent shape ─────────────────────────────────────────────

export interface MappedAgent {
  id: string;
  agent_name: string;
  agent_status: string;
  description: string;
  live: boolean;
}

export function mapRasenAgent(a: any): MappedAgent {
  const state = String(a?.state || "");
  return {
    id: a?.id,
    agent_name: a?.name || a?.id || "Untitled Agent",
    // `live` admits calls; `paused` refuses new calls; `draft` was never published.
    agent_status: state === "live" ? "active" : state || "draft",
    description: a?.description || "",
    live: state === "live",
  };
}

// ─── Phone number → internal shape ────────────────────────────────────────────

export interface MappedPhoneNumber {
  id: string;
  phone_number: string;
  name: string;
  provider: string | null;
  status: string | null;
  supports_inbound: boolean;
  supports_outbound: boolean;
  inbound_agent_id: string | null;
  outbound_agent_ids: string[];
}

export function mapRasenPhoneNumber(p: any): MappedPhoneNumber {
  return {
    id: p?.id,
    phone_number: p?.number || "",
    name: p?.label || p?.number || "",
    provider: p?.provider || null,
    status: p?.inbound_setup || null,
    supports_inbound: !!p?.supports_inbound,
    supports_outbound: !!p?.supports_outbound,
    inbound_agent_id: p?.inbound_agent_id || null,
    outbound_agent_ids: Array.isArray(p?.outbound_agent_ids) ? p.outbound_agent_ids : [],
  };
}

// ─── Call → internal execution shape ──────────────────────────────────────────
// This is the shape syncPoller.ts and dashboardRoutes.ts read field-by-field.

export interface MappedExecution {
  id: string;
  agent_id: string;
  batch_id: string | null;
  /** Internal lifecycle: queued | in-progress | ended. */
  status: string;
  /**
   * Why the call ended, in ONE normalised vocabulary (see `normaliseEndedReason`). null while the
   * call is still in flight. Without it the outcome classifier can only say "unknown" for calls
   * with no transcript — busy/no-answer would be unclassifiable.
   */
  ended_reason: string | null;
  /** Raw Rasen values, kept verbatim for logs and for forward-compatibility with new vocabulary. */
  raw_state: string;
  raw_end_reason: string | null;
  raw_dial_outcome: string | null;
  dial_sip_code: number | null;
  conversation_time: number;
  transcript: string;
  summary: string;
  created_at: string;
  updated_at: string | null;
  ended_at: string | null;
  total_cost: number;
  avg_latency_ms: number | null;
  cost_breakdown: { llm: number; network: number; platform: number; synthesizer: number; transcriber: number };
  extracted_data: Record<string, any> | null;
  metadata: Record<string, string>;
  /** True when every result (transcript/extraction/summary) has settled — nothing more will change. */
  results_final: boolean;
  telephony_data: {
    to_number: string;
    from_number: string;
    /** `web` = a browser / hosted test call: no phone number on either side, never dialled. */
    call_type: "inbound" | "outbound" | "web";
    /** Our own authenticated proxy path for the recording ("" when none). Rasen never returns a URL. */
    recording_url: string;
  };
}

export interface RasenCallExtras {
  /** Transcript turns (`GET /calls/{id}/transcript` items, or `call.analyzed` → transcript.turns). */
  turns?: any[] | null;
  /** `GET /calls/{id}/summary` body, or `call.analyzed` → summary. */
  summary?: any | null;
  /** `GET /calls/{id}/extraction` body, or `call.analyzed` → extraction. */
  extraction?: any | null;
  /** True when a verified recording exists (`call.analyzed` → recording.available). */
  recordingAvailable?: boolean | null;
  /** Billable seconds from `GET /usage?call_id=…` (telephony seconds). Preferred over wall-clock. */
  usageSeconds?: number | null;
  /** Customer number resolved outside the Call (inbound: before-call tool `system__caller_id`). */
  customerNumber?: string | null;
  /** Our number (E.164) for `from_number_id`, when the caller has resolved it. */
  ourNumber?: string | null;
}

const NOT_CONNECTED = new Set(["no_answer", "busy", "rejected", "invalid_number", "failed", "unreachable", "cancelled", "canceled", "timeout"]);

/**
 * Collapse Rasen's two outcome fields into the single reason vocabulary the outcome classifier
 * (callRetryPolicy.ts) reads:
 *
 *   busy | no_answer | rejected | invalid_number | carrier_failed | never_connected   (never connected)
 *   voicemail                                                                         (a machine answered)
 *   agent_hangup | customer_hangup | line_dropped | max_duration | inactivity
 *   transferred | transfer_failed | completed                                         (connected)
 *
 * Rasen's vocabularies are OPEN: an unknown value is passed through verbatim (never guessed into
 * a success), so the classifier can treat it as "unknown".
 */
export function normaliseEndedReason(c: any): string | null {
  if (!c?.terminal && !c?.ended_at) return null;
  const end = String(c?.end_reason || "").toLowerCase();
  const dial = String(c?.dial_outcome || "").toLowerCase();

  if (end === "voicemail_detected" || dial === "voicemail") return "voicemail";

  if (end === "never_connected" || String(c?.state || "") === "aborted") {
    if (dial === "busy") return "busy";
    if (dial === "no_answer") return "no_answer";
    if (dial === "rejected") return "rejected";
    if (dial === "invalid_number") return "invalid_number";
    if (dial === "failed") return "carrier_failed";
    if (dial && dial !== "dialing" && dial !== "answered") return dial; // unknown carrier report, verbatim
    return "never_connected";
  }

  if (end) {
    if (end === "user_hangup" || end === "caller_hangup") return "customer_hangup";
    if (end === "max_duration_reached" || end === "max_call_duration") return "max_duration";
    if (end === "inactivity_timeout") return "inactivity";
    return end; // agent_hangup, line_dropped, transferred, transfer_failed, completed, …verbatim
  }
  if (dial && NOT_CONNECTED.has(dial)) return dial === "failed" ? "carrier_failed" : dial;
  return c?.terminal ? "completed" : null;
}

/** Rasen lifecycle → the internal status the poller and UI use. */
export function mapRasenCallStatus(c: any): string {
  if (c?.terminal) return "ended";
  const s = String(c?.state || "");
  if (s === "active") return "in-progress";
  if (s === "evidence_pending") return "ended"; // the conversation is over; results are finishing
  return "queued"; // admitted (dialling) and anything not yet active
}

/** True when the call connected to a person/machine at all (media was accepted). */
export function rasenCallConnected(c: any): boolean {
  const reason = normaliseEndedReason(c);
  if (!reason) return false;
  return !["busy", "no_answer", "rejected", "invalid_number", "carrier_failed", "never_connected"].includes(reason)
    && !NOT_CONNECTED.has(reason);
}

/** Speaker label → the two labels the transcript text uses everywhere in the app. */
export function speakerLabel(speaker: any): "AI" | "Customer" {
  const s = String(speaker || "").toLowerCase();
  return s === "agent" || s === "assistant" || s === "bot" || s === "ai" ? "AI" : "Customer";
}

/** Transcript turns → the flat "AI: … / Customer: …" text stored on Call.transcript. */
export function buildTranscriptText(turns: any[] | null | undefined): string {
  if (!Array.isArray(turns)) return "";
  return turns
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
    .map((t) => `${speakerLabel(t.speaker)}: ${t.text.trim()}`)
    .join("\n");
}

/**
 * Mean agent response latency (ms): for each agent turn that follows a customer turn,
 * latency ≈ (agent start) − (customer end), from the per-turn `start_ms`/`end_ms`.
 * null when timing is absent, so the UI shows "—" instead of a fake 0.
 */
export function computeAvgLatencyMs(turns: any[] | null | undefined): number | null {
  if (!Array.isArray(turns) || turns.length < 2) return null;
  const sorted = [...turns].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const lat: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i], prev = sorted[i - 1];
    if (speakerLabel(cur.speaker) === "AI" && speakerLabel(prev.speaker) === "Customer") {
      const userEnd = typeof prev.end_ms === "number" ? prev.end_ms : null;
      const botStart = typeof cur.start_ms === "number" ? cur.start_ms : null;
      if (userEnd != null && botStart != null && botStart >= userEnd && botStart - userEnd < 60_000) {
        lat.push(botStart - userEnd);
      }
    }
  }
  return lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
}

/** Extraction result → a flat `{ field: value }` object (only fields that established a value). */
export function mapExtraction(extraction: any): Record<string, any> | null {
  if (!extraction || String(extraction.state || "") !== "ready" || !Array.isArray(extraction.fields)) return null;
  const out: Record<string, any> = {};
  for (const f of extraction.fields) {
    if (f && typeof f.name === "string" && f.value !== null && f.value !== undefined) out[f.name] = f.value;
  }
  return Object.keys(out).length ? out : null;
}

function settled(state: any): boolean {
  const s = String(state || "");
  return s !== "pending" && s !== "processing" && s !== "queued" && s !== "";
}

/** Relative path of our authenticated recording proxy for a call. */
export function recordingProxyPath(callId: string): string {
  return `/api/voice/calls/${encodeURIComponent(callId)}/recording`;
}

export function mapRasenCall(c: any, extras: RasenCallExtras = {}): MappedExecution {
  // The provider labels a call inbound / outbound; anything else (`none`, a future value) is a
  // call no carrier placed — a browser or hosted test call.
  const rawDirection = String(c?.direction || "").toLowerCase();
  const direction: "inbound" | "outbound" | "web" =
    rawDirection === "inbound" ? "inbound" : rawDirection === "outbound" ? "outbound" : "web";
  const metadata: Record<string, string> = c?.metadata && typeof c.metadata === "object" ? c.metadata : {};

  const customerNumber = String(extras.customerNumber || metadata.to_number || metadata.customer_number || "");
  const ourNumber = String(extras.ourNumber || metadata.from_number || "");

  // Duration. Billable telephony seconds from /usage win when present; otherwise the transcript
  // span (first turn start → last turn end); otherwise wall-clock created→ended for a call that
  // connected. A call that never connected is always 0 — ringing time is not conversation.
  const connected = rasenCallConnected(c);
  let conversationTime = 0;
  if (typeof extras.usageSeconds === "number" && extras.usageSeconds > 0) {
    conversationTime = Math.round(extras.usageSeconds);
  } else if (connected) {
    const turns = Array.isArray(extras.turns) ? extras.turns : [];
    const ends = turns.map((t) => Number(t?.end_ms)).filter((n) => Number.isFinite(n) && n > 0);
    if (ends.length) {
      conversationTime = Math.round(Math.max(...ends) / 1000);
    } else {
      const started = c?.created_at ? Date.parse(c.created_at) : NaN;
      const ended = c?.ended_at ? Date.parse(c.ended_at) : NaN;
      if (Number.isFinite(started) && Number.isFinite(ended)) {
        conversationTime = Math.max(0, Math.round((ended - started) / 1000));
      }
    }
  }

  const hasRecording =
    extras.recordingAvailable === true ||
    (extras.recordingAvailable == null && connected && !!c?.terminal && conversationTime > 0);

  const summaryText =
    extras.summary && String(extras.summary.state || "") === "ready" && typeof extras.summary.summary === "string"
      ? extras.summary.summary
      : "";

  return {
    id: c?.id,
    agent_id: c?.agent_id || "",
    batch_id: metadata.campaign_id || metadata.batch_id || null,
    status: mapRasenCallStatus(c),
    ended_reason: normaliseEndedReason(c),
    raw_state: String(c?.state || ""),
    raw_end_reason: c?.end_reason ?? null,
    raw_dial_outcome: c?.dial_outcome ?? null,
    dial_sip_code: typeof c?.dial_sip_code === "number" ? c.dial_sip_code : null,
    conversation_time: conversationTime,
    transcript: buildTranscriptText(extras.turns),
    summary: summaryText,
    created_at: c?.created_at,
    updated_at: c?.updated_at || null,
    ended_at: c?.ended_at || null,
    // Rasen reports quantities, never a price. The poller prices the call from the tenant's rate.
    total_cost: 0,
    avg_latency_ms: computeAvgLatencyMs(extras.turns),
    cost_breakdown: { llm: 0, network: 0, platform: 0, synthesizer: 0, transcriber: 0 },
    extracted_data: mapExtraction(extras.extraction),
    metadata,
    results_final:
      !!c?.terminal &&
      settled(c?.transcript_state) &&
      settled(c?.extraction_state) &&
      settled(c?.summary_state) &&
      (c?.poll_after_seconds === null || c?.poll_after_seconds === undefined || !!c?.terminal),
    telephony_data: {
      // For outbound, the customer is the destination (to); for inbound, the caller (from).
      to_number: direction === "web" ? "" : direction === "inbound" ? ourNumber : customerNumber,
      from_number: direction === "web" ? "" : direction === "inbound" ? customerNumber : ourNumber,
      call_type: direction,
      recording_url: hasRecording && c?.id ? recordingProxyPath(c.id) : "",
    },
  };
}

// ─── Campaign state → internal campaign status ───────────────────────────────
// Internal vocabulary (Campaign model enum): draft|scheduled|running|completed|failed|stopped
// Idempotent: passing an already-internal value returns it unchanged.

export function mapRasenCampaignStatus(raw: string | undefined | null): string {
  if (!raw) return "running";
  const map: Record<string, string> = {
    // Rasen campaign states
    draft: "draft",
    planned: "scheduled",
    admitted: "scheduled",
    scheduled: "scheduled",
    running: "running",
    in_progress: "running",
    paused: "stopped",
    completed: "completed",
    complete: "completed",
    cancelled: "stopped",
    canceled: "stopped",
    failed: "failed",
    // internal values (idempotent)
    stopped: "stopped",
  };
  return map[String(raw).toLowerCase()] || "running";
}

// ─── Variables ────────────────────────────────────────────────────────────────

const VAR_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VARS = 64;
const MAX_VALUE = 4096;
const MAX_TOTAL_BYTES = 16 * 1024;

/**
 * Turn the app's free-form per-call variables into Rasen `dynamic_variables`:
 * a FLAT object of string values, ≤64 keys matching ^[a-z][a-z0-9_]{0,63}$, each value ≤4096
 * chars with no control characters (tab/newline allowed), ≤16 KiB in total.
 *
 * Nested objects are flattened with `_` (`contact.first_name` → `contact_first_name`), keys are
 * lower-cased and sanitised, and anything that cannot fit is dropped — never sent malformed,
 * because one bad variable would make Rasen refuse the whole call.
 */
export function toDynamicVariables(input: Record<string, any> | null | undefined): Record<string, string> {
  const flat: Record<string, string> = {};
  const walk = (prefix: string, value: any, depth: number) => {
    if (value === null || value === undefined) return;
    if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      if (depth >= 3) return;
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}_${k}` : k, v, depth + 1);
      return;
    }
    let key = prefix
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!key) return;
    if (!/^[a-z]/.test(key)) key = `v_${key}`;
    key = key.slice(0, 64);
    if (!VAR_KEY.test(key) || key.startsWith("system__")) return;
    const raw = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(", ") : String(value);
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").slice(0, MAX_VALUE);
    if (!(key in flat)) flat[key] = clean;
  };
  for (const [k, v] of Object.entries(input || {})) walk(k, v, 0);

  const out: Record<string, string> = {};
  let bytes = 2;
  let count = 0;
  for (const [k, v] of Object.entries(flat)) {
    if (count >= MAX_VARS) break;
    const size = Buffer.byteLength(JSON.stringify(k)) + Buffer.byteLength(JSON.stringify(v)) + 2;
    if (bytes + size > MAX_TOTAL_BYTES) {
      // Try a truncated value before giving up on the key (context blobs are the usual culprit).
      const room = MAX_TOTAL_BYTES - bytes - Buffer.byteLength(JSON.stringify(k)) - 8;
      if (room > 64) {
        let cut = v.slice(0, room);
        while (Buffer.byteLength(JSON.stringify(cut)) > room && cut.length > 0) cut = cut.slice(0, Math.floor(cut.length * 0.9));
        if (cut) { out[k] = cut; bytes += Buffer.byteLength(JSON.stringify(k)) + Buffer.byteLength(JSON.stringify(cut)) + 2; count++; }
      }
      continue;
    }
    out[k] = v;
    bytes += size;
    count++;
  }
  return out;
}

const META_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Build Rasen call `metadata`: ≤16 keys matching ^[a-z][a-z0-9_]{0,63}$, string values ≤512
 * chars, ≤4 KiB in total. Used for OUR correlation only (tenant, customer, campaign, number).
 */
export function toCallMetadata(input: Record<string, any> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let bytes = 2;
  for (const [k, v] of Object.entries(input || {})) {
    if (Object.keys(out).length >= 16) break;
    if (v === null || v === undefined || v === "") continue;
    if (!META_KEY.test(k)) continue;
    const val = String(v).slice(0, 512);
    const size = Buffer.byteLength(JSON.stringify(k)) + Buffer.byteLength(JSON.stringify(val)) + 2;
    if (bytes + size > 4096) continue;
    out[k] = val;
    bytes += size;
  }
  return out;
}

/** Normalise a phone number to E.164 (`+` and 8–15 digits). Returns "" when it cannot be one. */
export function toE164(raw: any, defaultCountryCode = "91"): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  const plus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (!plus) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.length === 10) digits = `${defaultCountryCode}${digits}`;
    else if (digits.length === 11 && digits.startsWith("0")) digits = `${defaultCountryCode}${digits.slice(1)}`;
  }
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return "";
  return `+${digits}`;
}
