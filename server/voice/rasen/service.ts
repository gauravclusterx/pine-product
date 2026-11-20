/**
 * server/voice/rasen/service.ts
 *
 * The Rasen (rasen.ai) voice integration layer. This is the ONLY place that talks to
 * https://api.rasen.ai. Everything else in the app imports from here.
 *
 * How Rasen differs from a "create and it is live" provider — and what this layer hides:
 *   • An agent has an editable DRAFT and an immutable LIVE version. Calls use the live version
 *     only. Every config change here is: PATCH draft → publish. Nothing is "saved but not live".
 *   • Draft/tool/number writes are optimistic: they need the current ETag in `If-Match`. On a
 *     stale revision we re-read once and retry.
 *   • Call start returns 202 "admitted", not "connected". The call is then read until terminal.
 *   • Transcript, summary, extraction and recording are separate reads; no recording URL exists.
 */
import FormData from "form-data";
import { parse as parseCsv } from "csv-parse/sync";
import { rasenRequest, rasenListAll, RasenError, RasenResponse } from "./client.js";
import {
  mapRasenAgent,
  mapRasenCall,
  mapRasenPhoneNumber,
  toCallMetadata,
  toDynamicVariables,
  toE164,
  MappedAgent,
  MappedExecution,
  MappedPhoneNumber,
  RasenCallExtras,
} from "./mappers.js";

export { RasenError } from "./client.js";

// ─── Credential resolution ───────────────────────────────────────────────────

/**
 * Every exported function takes the workspace key as its first argument: either the plaintext
 * key, or an object carrying it as `apiKey`. Keys are stored encrypted and are opened by the
 * caller (modules/voiceWorkspace.ts) — this layer never touches ciphertext or the database.
 */
export function getRasenApiKey(input: any): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (input && typeof input === "object" && typeof input.apiKey === "string" && input.apiKey.trim()) return input.apiKey.trim();
  throw new Error("Voice API key not configured");
}

/** True when a user (or key string) has a usable voice key. Never throws. */
export function hasRasenApiKey(input: any): boolean {
  try { return !!getRasenApiKey(input); } catch { return false; }
}

// ─── Key validation / workspace context ──────────────────────────────────────

export interface RasenContext {
  workspace_id: string;
  key_id: string;
  key_name: string | null;
  capabilities: string[];
  workspace_state: string;
  api_version: string;
  expires_at: string | null;
}

/** Capabilities the CRM needs from a tenant key. Missing ones are reported to the admin. */
export const REQUIRED_CAPABILITIES = [
  "config.read",
  "agents.write",
  "agents.publish",
  "tools.write",
  "numbers.assign",
  "calls.write",
  "calls.read",
  "usage.read",
] as const;

export async function getContext(input: any): Promise<RasenContext> {
  const res = await rasenRequest<RasenContext>(getRasenApiKey(input), "GET", "/context", { timeoutMs: 15_000 });
  return res.data;
}

export interface KeyValidation {
  valid: boolean;
  context: RasenContext | null;
  missingCapabilities: string[];
  reason: string | null;
}

/** Validate a plaintext key against `GET /context`. Never throws for a bad key. */
export async function inspectRasenApiKey(rawApiKey: string): Promise<KeyValidation> {
  try {
    const ctx = await getContext(String(rawApiKey || "").trim());
    const caps = new Set(ctx.capabilities || []);
    const missing = REQUIRED_CAPABILITIES.filter((c) => !caps.has(c));
    if (ctx.workspace_state && ctx.workspace_state !== "active") {
      return { valid: false, context: ctx, missingCapabilities: missing, reason: `workspace is ${ctx.workspace_state}` };
    }
    return { valid: true, context: ctx, missingCapabilities: missing, reason: null };
  } catch (err: any) {
    if (err instanceof RasenError && (err.status === 401 || err.status === 403)) {
      return { valid: false, context: null, missingCapabilities: [], reason: "key rejected" };
    }
    throw new Error(`Voice API validation failed: ${err?.message || err}`);
  }
}

export async function validateRasenApiKey(rawApiKey: string): Promise<boolean> {
  return (await inspectRasenApiKey(rawApiKey)).valid;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export async function listAgents(input: any, opts: { includeArchived?: boolean } = {}): Promise<any[]> {
  const key = getRasenApiKey(input);
  const live = await rasenListAll(key, "/agents", {}, 2000);
  if (!opts.includeArchived) return live;
  const archived = await rasenListAll(key, "/agents", { state: "archived" }, 2000);
  return [...live, ...archived];
}

export async function listMappedAgents(input: any): Promise<MappedAgent[]> {
  return (await listAgents(input)).map(mapRasenAgent);
}

export async function getAgent(input: any, agentId: string): Promise<any> {
  return (await rasenRequest(getRasenApiKey(input), "GET", `/agents/${enc(agentId)}`)).data;
}

export async function getAgentDraft(input: any, agentId: string): Promise<RasenResponse<any>> {
  return rasenRequest(getRasenApiKey(input), "GET", `/agents/${enc(agentId)}/draft`);
}

export interface VoiceInfo { id: string; name: string; gender: string | null; isDefault: boolean; available: boolean }

export async function listVoices(input: any): Promise<VoiceInfo[]> {
  const items = await rasenListAll(getRasenApiKey(input), "/voices", {}, 500);
  return items.map((v: any) => ({
    id: v.id,
    name: v.name || v.id,
    gender: v.grammatical_gender ?? null,
    isDefault: !!v.is_default,
    available: v.available !== false,
  }));
}

export type AgentLanguage = "en" | "hi" | "hinglish";

export interface AgentConfigInput {
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  firstMessage?: string;
  voiceId?: string | null;
  language?: AgentLanguage | string;
  timezone?: string;
  callDirection?: "inbound" | "outbound" | null;
  maxCallDurationSeconds?: number | null;
  inactivityTimeoutSeconds?: number | null;
  voicemailDetection?: boolean;
  voicemailAction?: "hang_up" | "leave_message";
  voicemailMessage?: string | null;
  backgroundAudio?: "office" | "call_centre" | "cafe" | null;
  /** Post-call fields Rasen extracts from the conversation (name/type/description/choices). */
  extractionFields?: Array<{ name: string; type: string; description?: string; required?: boolean; choices?: string[] }>;
  /** Number the agent may transfer the caller to ("" / null disables transfer). */
  transferNumber?: string | null;
  endCallEnabled?: boolean;
}

const CREATE_LANGUAGE: Record<AgentLanguage, string> = { en: "english", hi: "hindi", hinglish: "hinglish" };

/** Languages Rasen accepts. Anything else falls back to hinglish (the multilingual option). */
export function normaliseLanguage(lang: any): AgentLanguage {
  const s = String(lang || "").toLowerCase();
  if (s === "en" || s.startsWith("en-")) return "en";
  if (s === "hi" || s.startsWith("hi-")) return "hi";
  return "hinglish";
}

/**
 * Appendix stitched onto EVERY voice agent's system prompt — at creation and on every CRM
 * prompt/knowledge push. It renders the platform-injected `{{context}}` / `{{profile}}` call
 * variables and pins language behaviour, so a brand-new agent knows the customer and holds its
 * language WITHOUT the user writing any variables by hand.
 */
export const VOICE_PROMPT_APPENDIX =
  "\n\n────────────────────────────────\n" +
  "CUSTOMER CONTEXT (auto-injected by the platform — real data, not an example):\n{{context}}\n\n" +
  "CUSTOMER PROFILE:\n{{profile}}\n\n" +
  "LANGUAGE LOCK (overrides everything above)\n" +
  "● Start the call in English, or in the customer's preferred language when the context names one.\n" +
  "● Detect the language of the customer's FIRST substantial reply and LOCK onto it for the whole call. Never switch on your own between turns.\n" +
  "● Switch ONLY when the customer explicitly asks — then lock onto the new language.\n\n" +
  "USING THE CONTEXT\n" +
  "● The context above is this customer's REAL history (messages, past calls, form answers, upcoming meeting). When asked what you know or to summarise earlier conversations, answer FROM it in 2-3 natural sentences — NEVER claim you don't have access when it has content.\n" +
  "● Never read it out verbatim and never mention 'context', 'system' or 'data' — speak like a colleague who simply remembers.\n" +
  "● When the profile gives a name on file, that is the customer's name: greet them by it and NEVER ask for their name. If they give a different name, you may use it in conversation, but do not ask again.\n" +
  "● Greet the customer by name at most ONCE in the call, naturally — never repeat the name in later sentences.\n" +
  "● State dates/times EXACTLY as written there. The context includes the current date & time — use it for 'today'/'tomorrow'.\n" +
  "● Times: never work out dates yourself. Use the availability tool, offer its windows by day and time, and book with the start value of the window the customer picked.\n" +
  "● If the customer asks to be called back, save it with the lead tool, including when they want the call.";

const APPENDIX_MARK = "CUSTOMER CONTEXT (auto-injected by the platform";

/**
 * The CRM's merge fields are written `{{contact.city}}` (a nested alias). Call variables at the
 * provider are FLAT (`contact_city`) and a dot there means "a field of a tool result", so the
 * alias is rewritten to the flat name the variable is actually sent under (`toDynamicVariables`
 * flattens the same way). Only the `contact.` alias is touched — `{{lookup_caller.name|there}}`
 * (a real tool-result reference) is left alone.
 */
export function flattenMergeFields(text: string): string {
  return String(text || "").replace(/\{\{\s*contact\.([A-Za-z0-9_ ]{1,60}?)\s*(\|[^}]*)?\}\}/g, (_m, key: string, fallback?: string) => {
    const flat = String(key).trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    return flat ? `{{contact_${flat}${fallback || ""}}}` : _m;
  });
}

/** Prompt with the appendix attached exactly once (idempotent — safe to call on every push). */
export function withPromptAppendix(prompt: string): string {
  const base = stripPromptAppendix(prompt || "You are a helpful, friendly voice assistant.");
  return `${flattenMergeFields(base)}${VOICE_PROMPT_APPENDIX}`;
}

/** The user-authored part of a stored prompt (appendix removed) — what the editor should show. */
export function stripPromptAppendix(prompt: string): string {
  const s = String(prompt || "");
  const i = s.indexOf(APPENDIX_MARK);
  if (i < 0) return s.trimEnd();
  // Everything from the marker on is ours, and so is the separator rule right above it.
  return s.slice(0, i).replace(/[\s─]+$/u, "");
}

/** Variables the appendix references. Declared with empty defaults so they render blank, never as raw `{{…}}`. */
const PLATFORM_VARIABLES: Array<{ key: string; description: string; sensitivity: "internal" | "pii" }> = [
  { key: "context", description: "Cross-channel history of this customer, injected per call by the CRM.", sensitivity: "internal" },
  { key: "profile", description: "CRM profile of this customer, injected per call by the CRM.", sensitivity: "internal" },
  // Not referenced by the prompt: the agent's tools send it back to the CRM so a booking made on
  // an OUTBOUND call lands on the right customer (the tool request carries no call id).
  { key: "customer_phone", description: "Phone number of the customer on this call (set by the CRM on outbound calls).", sensitivity: "pii" },
];

function settingsPatch(cfg: AgentConfigInput): Record<string, any> {
  const s: Record<string, any> = {};
  if (cfg.name !== undefined) s.agent_name = String(cfg.name).slice(0, 120);
  if (cfg.firstMessage !== undefined) s.first_message = flattenMergeFields(String(cfg.firstMessage || "")).slice(0, 2000);
  if (cfg.language !== undefined) s.language = normaliseLanguage(cfg.language);
  if (cfg.timezone) s.timezone = cfg.timezone;
  if (cfg.callDirection !== undefined) s.call_direction = cfg.callDirection;
  if (cfg.maxCallDurationSeconds !== undefined) s.max_call_duration_seconds = cfg.maxCallDurationSeconds;
  if (cfg.inactivityTimeoutSeconds !== undefined) s.inactivity_timeout_seconds = cfg.inactivityTimeoutSeconds;
  if (cfg.voicemailDetection !== undefined) s.voicemail_detection = !!cfg.voicemailDetection;
  if (cfg.voicemailAction !== undefined) s.voicemail_action = cfg.voicemailAction;
  if (cfg.voicemailMessage !== undefined) s.voicemail_message = cfg.voicemailMessage ? String(cfg.voicemailMessage).slice(0, 500) : null;
  if (cfg.backgroundAudio !== undefined) s.bg_audio = cfg.backgroundAudio;
  if (cfg.extractionFields !== undefined) {
    s.extraction_fields = (cfg.extractionFields || [])
      .filter((f) => f && /^[a-z][a-z0-9_]*$/.test(String(f.name || "")))
      .slice(0, 50)
      .map((f) => ({
        name: f.name.slice(0, 64),
        type: ["text", "boolean", "number", "selector", "datetime"].includes(f.type) ? f.type : "text",
        ...(f.description ? { description: String(f.description).slice(0, 500) } : {}),
        ...(f.required !== undefined ? { required: !!f.required } : {}),
        ...(f.type === "selector" && Array.isArray(f.choices) ? { choices: f.choices.map((c) => String(c).slice(0, 120)) } : {}),
      }));
  }
  return s;
}

function defaultToolsPatch(cfg: AgentConfigInput): Record<string, any> | undefined {
  const d: Record<string, any> = {};
  if (cfg.endCallEnabled !== undefined) d.end_call = { enabled: !!cfg.endCallEnabled };
  if (cfg.transferNumber !== undefined) {
    const n = toE164(cfg.transferNumber || "");
    d.transfer = n ? { enabled: true, destination_number: n } : { enabled: false };
  }
  return Object.keys(d).length ? d : undefined;
}

/** Build a draft PATCH body from simple fields. Pure + deterministic so it is unit-testable. */
export function buildDraftPatch(cfg: AgentConfigInput): Record<string, any> {
  const patch: Record<string, any> = {};
  if (cfg.systemPrompt !== undefined) patch.prompt = withPromptAppendix(cfg.systemPrompt);
  if (cfg.voiceId !== undefined) patch.voice = { voice_id: cfg.voiceId || null };
  const settings = settingsPatch(cfg);
  if (Object.keys(settings).length) patch.settings = settings;
  const dt = defaultToolsPatch(cfg);
  if (dt) patch.default_tools = dt;
  return patch;
}

/** Build the `POST /agents` body. Pure + deterministic so it is unit-testable. */
export function buildAgentCreatePayload(cfg: AgentConfigInput & { name: string; resourceKey?: string }): Record<string, any> {
  const draft = buildDraftPatch({ ...cfg, systemPrompt: cfg.systemPrompt ?? "" });
  // Multilingual by default: an English-locked agent turns Hindi/Gujarati speech into word salad.
  draft.settings = { language: "hinglish", ...(draft.settings || {}) };
  // Rasen quirk: `initial_draft` spells languages out (english|hindi|hinglish); every later draft
  // edit uses the short codes (en|hi|hinglish). Translate here so callers only know the codes.
  draft.settings.language = CREATE_LANGUAGE[normaliseLanguage(draft.settings.language)];
  const body: Record<string, any> = {
    name: String(cfg.name || "Untitled Agent").slice(0, 120),
    initial_draft: draft,
  };
  if (cfg.description) body.description = String(cfg.description).slice(0, 2000);
  if (cfg.resourceKey && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(cfg.resourceKey)) body.resource_key = cfg.resourceKey;
  return body;
}

/** Run a write that needs the draft ETag; on a stale revision, re-read once and retry. */
async function withDraftEtag<T>(
  key: string,
  agentId: string,
  write: (etag: string) => Promise<RasenResponse<T>>
): Promise<RasenResponse<T>> {
  let etag = (await rasenRequest(key, "GET", `/agents/${enc(agentId)}/draft`)).etag;
  if (!etag) throw new Error("Voice provider returned no draft revision");
  try {
    return await write(etag);
  } catch (err: any) {
    if (err instanceof RasenError && (err.status === 412 || err.code === "revision_mismatch" || err.code === "precondition_failed" || (err.status === 409 && /revision|etag|stale/i.test(`${err.code} ${err.details?.reason || ""}`)))) {
      etag = (await rasenRequest(key, "GET", `/agents/${enc(agentId)}/draft`)).etag;
      if (!etag) throw err;
      return await write(etag);
    }
    throw err;
  }
}

async function ensurePlatformVariables(key: string, agentId: string): Promise<void> {
  const draft = (await rasenRequest<any>(key, "GET", `/agents/${enc(agentId)}/draft`)).data;
  const have = new Set((draft?.variables || []).map((v: any) => v.key));
  for (const v of PLATFORM_VARIABLES) {
    if (have.has(v.key)) continue;
    await withDraftEtag(key, agentId, (etag) =>
      rasenRequest(key, "PUT", `/agents/${enc(agentId)}/variables/${enc(v.key)}`, {
        ifMatch: etag,
        body: { value: "", description: v.description, sensitivity: v.sensitivity },
      })
    );
  }
}

/** Publish the agent's current draft so it becomes the live version new calls use. */
export async function publishAgent(input: any, agentId: string): Promise<{ liveVersionId: string | null; created: boolean }> {
  const key = getRasenApiKey(input);
  const res = await withDraftEtag<any>(key, agentId, (etag) =>
    rasenRequest(key, "POST", `/agents/${enc(agentId)}/publish`, { ifMatch: etag, timeoutMs: 60_000 })
  );
  return { liveVersionId: res.data?.live_version_id || null, created: !!res.data?.created };
}

/** Create a voice agent from simple fields, declare the platform variables, and publish it. */
export async function createAgent(
  input: any,
  cfg: AgentConfigInput & { name: string; resourceKey?: string },
  opts: { publish?: boolean } = {}
): Promise<{ id: string; name: string; state: string; liveVersionId: string | null; publishError: string | null }> {
  const key = getRasenApiKey(input);
  const created = (await rasenRequest<any>(key, "POST", "/agents", { body: buildAgentCreatePayload(cfg) })).data;
  let liveVersionId: string | null = null;
  let publishError: string | null = null;
  let state = created.state;
  try {
    await ensurePlatformVariables(key, created.id);
    if (opts.publish !== false) {
      liveVersionId = (await publishAgent(key, created.id)).liveVersionId;
      state = "live";
    }
  } catch (err: any) {
    // The agent exists as a draft. Report why it is not live instead of losing it.
    publishError = describeRasenError(err);
  }
  return { id: created.id, name: created.name, state, liveVersionId, publishError };
}

/** Full editable configuration of an agent, in the simple shape the CRM UI edits. */
export async function getAgentConfig(input: any, agentId: string): Promise<{
  id: string; name: string; description: string; state: string; liveVersionId: string | null;
  systemPrompt: string; firstMessage: string; voiceId: string | null; language: string; timezone: string;
  callDirection: string | null; maxCallDurationSeconds: number | null; inactivityTimeoutSeconds: number | null;
  voicemailDetection: boolean; voicemailAction: string; voicemailMessage: string; backgroundAudio: string | null;
  extractionFields: any[]; transferNumber: string; endCallEnabled: boolean; toolIds: string[]; updatedAt: string | null;
}> {
  const key = getRasenApiKey(input);
  const [agent, draft] = await Promise.all([
    rasenRequest<any>(key, "GET", `/agents/${enc(agentId)}`),
    rasenRequest<any>(key, "GET", `/agents/${enc(agentId)}/draft`),
  ]);
  const a = agent.data || {};
  const d = draft.data || {};
  const s = d.settings || {};
  const transfer = d.default_tools?.transfer || {};
  const firstDest = Array.isArray(transfer.destinations) && transfer.destinations.length ? transfer.destinations[0] : null;
  return {
    id: a.id,
    name: a.name || "",
    description: a.description || "",
    state: a.state || "",
    liveVersionId: a.live_version_id || null,
    systemPrompt: stripPromptAppendix(d.prompt || ""),
    firstMessage: s.first_message || "",
    voiceId: d.voice?.voice_id ?? null,
    language: s.language || "hinglish",
    timezone: s.timezone || "",
    callDirection: s.call_direction ?? null,
    maxCallDurationSeconds: s.max_call_duration_seconds ?? null,
    inactivityTimeoutSeconds: s.inactivity_timeout_seconds ?? null,
    voicemailDetection: !!s.voicemail_detection,
    voicemailAction: s.voicemail_action || "hang_up",
    voicemailMessage: s.voicemail_message || "",
    backgroundAudio: s.bg_audio ?? null,
    extractionFields: Array.isArray(s.extraction_fields) ? s.extraction_fields : [],
    transferNumber: transfer.enabled ? (transfer.destination_number || firstDest?.target?.number || firstDest?.target?.e164 || "") : "",
    endCallEnabled: d.default_tools?.end_call?.enabled !== false,
    toolIds: Array.isArray(d.tool_ids) ? d.tool_ids : [],
    updatedAt: d.updated_at || a.updated_at || null,
  };
}

/**
 * Change an agent's configuration and make it live: rename (if asked) → PATCH draft → publish.
 * A change that is saved but not published would silently not apply to calls, so this always
 * publishes unless `publish: false` is passed (used to batch several edits before one publish).
 */
export async function updateAgentConfig(
  input: any,
  agentId: string,
  cfg: AgentConfigInput,
  opts: { publish?: boolean } = {}
): Promise<{ liveVersionId: string | null }> {
  const key = getRasenApiKey(input);

  if (cfg.name !== undefined || cfg.description !== undefined) {
    const cur = await rasenRequest<any>(key, "GET", `/agents/${enc(agentId)}`);
    const patch: Record<string, any> = {};
    if (cfg.name !== undefined && cfg.name !== cur.data?.name) patch.name = String(cfg.name).slice(0, 120);
    if (cfg.description !== undefined && (cfg.description || null) !== (cur.data?.description || null)) patch.description = cfg.description || null;
    if (Object.keys(patch).length) {
      await rasenRequest(key, "PATCH", `/agents/${enc(agentId)}`, { ifMatch: cur.etag, body: patch });
    }
  }

  const draftPatch = buildDraftPatch(cfg);
  if (Object.keys(draftPatch).length) {
    await withDraftEtag(key, agentId, (etag) =>
      rasenRequest(key, "PATCH", `/agents/${enc(agentId)}/draft`, { ifMatch: etag, body: draftPatch })
    );
  }
  if (cfg.systemPrompt !== undefined) await ensurePlatformVariables(key, agentId);
  if (opts.publish === false) return { liveVersionId: null };
  return { liveVersionId: (await publishAgent(key, agentId)).liveVersionId };
}

/** Replace an agent's system prompt (used to push a knowledge base) and publish. Keeps every other setting. */
export async function updateAgentPrompt(input: any, agentId: string, systemPrompt: string): Promise<{ liveVersionId: string | null }> {
  return updateAgentConfig(input, agentId, { systemPrompt });
}

/**
 * Remove an agent. Rasen has no hard delete: the agent is archived (hidden, refuses calls) and
 * permanently deleted by Rasen 14 days later. Already-archived / missing agents are a no-op.
 */
export async function archiveAgent(input: any, agentId: string): Promise<void> {
  try {
    await rasenRequest(getRasenApiKey(input), "POST", `/agents/${enc(agentId)}/archive`);
  } catch (err: any) {
    if (err instanceof RasenError && (err.status === 404 || /archiv/i.test(err.code))) return;
    throw err;
  }
}

/** Whether the agent can take calls right now, and why not when it cannot. */
export async function getAgentReadiness(input: any, agentId: string): Promise<{ ready: boolean; state: string; reasons: string[] }> {
  const r = (await rasenRequest<any>(getRasenApiKey(input), "GET", `/agents/${enc(agentId)}/readiness`)).data || {};
  const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((x: any) => (typeof x === "string" ? x : x?.code || x?.reason || JSON.stringify(x)));
  return { ready: String(r.state || "") === "ready", state: String(r.state || ""), reasons };
}

// ─── Agent tools (webhooks the agent calls on OUR server) ────────────────────

export interface WebhookToolSpec {
  name: string;
  description: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `pre_call` = the before-call tool (inbound only, one per agent). Default `during_call`. */
  timing?: "during_call" | "pre_call";
  sideEffect?: "none" | "idempotent" | "unknown";
  parameters?: Array<{
    name: string;
    location: "path" | "query" | "body";
    source: "model" | "constant" | "dynamic_variable";
    value?: string | number | boolean;
    required?: boolean;
    type?: "string" | "number" | "integer" | "boolean";
    description?: string;
    enum?: string[];
  }>;
  /** Secret header the tool sends to our server (sealed by Rasen; never readable back). */
  secretHeader?: { name: string; value: string };
  deadlineMs?: number;
}

/** Build a Rasen `ToolWrite` body. Pure so it is unit-testable. */
export function buildWebhookTool(spec: WebhookToolSpec, opts: { keepCredential?: boolean } = {}): Record<string, any> {
  const pre = spec.timing === "pre_call";
  const definition: Record<string, any> = {
    url: spec.url,
    method: spec.method || "POST",
    parameters: (spec.parameters || []).map((p) => ({
      name: p.name,
      location: p.location,
      source: p.source,
      ...(p.source !== "model" && p.value !== undefined ? { value: p.value } : {}),
      ...(p.required !== undefined ? { required: !!p.required } : {}),
      schema: {
        type: p.type || "string",
        ...(p.description ? { description: p.description.slice(0, 500) } : {}),
        ...(p.enum ? { enum: p.enum } : {}),
      },
    })),
  };
  if ((definition.method === "POST" || definition.method === "PUT" || definition.method === "PATCH")) {
    definition.content_type = "application/json";
  }
  if (spec.secretHeader) {
    definition.headers = [
      opts.keepCredential
        ? { name: spec.secretHeader.name, value_type: "secret" }
        : { name: spec.secretHeader.name, value_type: "secret", credential: { value: spec.secretHeader.value, material_kind: "api_key" } },
    ];
  }
  return {
    kind: "webhook",
    name: spec.name,
    description: spec.description.slice(0, 2000),
    timing: pre ? "pre_call" : "during_call",
    // A before-call tool is a lookup: no side effect, no automatic retry (Rasen requires both).
    side_effect: pre ? "none" : spec.sideEffect || "unknown",
    retry_posture: "none",
    wait_for_response: true,
    ...(spec.deadlineMs ? { deadline_ms: spec.deadlineMs } : pre ? { deadline_ms: 4000 } : {}),
    definition,
  };
}

export async function listAgentTools(input: any, agentId: string): Promise<any[]> {
  return rasenListAll(getRasenApiKey(input), `/agents/${enc(agentId)}/tools`, {}, 200);
}

/**
 * Make the agent's draft carry exactly the given webhook tools (matched by name): create missing
 * ones, replace changed ones, and optionally delete tools we previously managed that are no longer
 * wanted. Does NOT publish — the caller publishes once after all draft edits.
 */
export async function syncAgentTools(
  input: any,
  agentId: string,
  specs: WebhookToolSpec[],
  opts: { removeNames?: string[] } = {}
): Promise<{ created: string[]; replaced: string[]; removed: string[] }> {
  const key = getRasenApiKey(input);
  const existing = await listAgentTools(key, agentId);
  const nameOf = (t: any) => t?.configuration?.name || t?.name;
  const byName = new Map<string, any>(existing.map((t: any) => [nameOf(t), t]));
  const out = { created: [] as string[], replaced: [] as string[], removed: [] as string[] };

  for (const spec of specs) {
    const cur = byName.get(spec.name);
    if (!cur) {
      await withDraftEtag(key, agentId, (etag) =>
        rasenRequest(key, "POST", `/agents/${enc(agentId)}/tools`, { ifMatch: etag, body: buildWebhookTool(spec) })
      );
      out.created.push(spec.name);
    } else {
      await withDraftEtag(key, agentId, (etag) =>
        rasenRequest(key, "PUT", `/agents/${enc(agentId)}/tools/${enc(cur.id)}`, { ifMatch: etag, body: buildWebhookTool(spec) })
      );
      out.replaced.push(spec.name);
    }
  }
  for (const name of opts.removeNames || []) {
    const cur = byName.get(name);
    if (!cur || specs.some((s) => s.name === name)) continue;
    await withDraftEtag(key, agentId, (etag) =>
      rasenRequest(key, "DELETE", `/agents/${enc(agentId)}/tools/${enc(cur.id)}`, { ifMatch: etag })
    );
    out.removed.push(name);
  }
  return out;
}

/**
 * The request a tool actually sent on one call (from the tool-run log). Used to recover the
 * caller's number of an INBOUND call: the before-call tool sent it as a parameter.
 */
export async function listToolRunsForCall(input: any, agentId: string, toolId: string, callId: string): Promise<any[]> {
  return rasenListAll(getRasenApiKey(input), `/agents/${enc(agentId)}/tools/${enc(toolId)}/runs`, { call_id: callId }, 20);
}

// ─── Phone numbers ───────────────────────────────────────────────────────────

export async function listPhoneNumbers(input: any): Promise<any[]> {
  return rasenListAll(getRasenApiKey(input), "/phone-numbers", {}, 1000);
}

export async function listMappedPhoneNumbers(input: any): Promise<MappedPhoneNumber[]> {
  return (await listPhoneNumbers(input)).map(mapRasenPhoneNumber);
}

async function withNumberEtag<T>(key: string, numberId: string, write: (etag: string) => Promise<RasenResponse<T>>): Promise<RasenResponse<T>> {
  const read = async () => {
    const r = await rasenRequest<any>(key, "GET", `/phone-numbers/${enc(numberId)}`);
    return r.etag || r.data?.revision || null;
  };
  let etag = await read();
  if (!etag) throw new Error("Voice provider returned no number revision");
  try {
    return await write(etag);
  } catch (err: any) {
    if (err instanceof RasenError && (err.status === 412 || /revision|precondition/i.test(err.code))) {
      etag = await read();
      if (!etag) throw err;
      return await write(etag);
    }
    throw err;
  }
}

/** Route INBOUND calls on a number to an agent, and configure the carrier where supported. */
export async function setInboundAgent(input: any, numberId: string, agentId: string): Promise<{ setupState: string; nextAction: string | null }> {
  const key = getRasenApiKey(input);
  const res = await withNumberEtag<any>(key, numberId, (etag) =>
    rasenRequest(key, "PUT", `/phone-numbers/${enc(numberId)}/assignments/inbound`, {
      ifMatch: etag,
      body: { agent_id: agentId, configure_inbound: true },
      timeoutMs: 60_000,
    })
  );
  return { setupState: String(res.data?.setup_state || ""), nextAction: res.data?.next_action || null };
}

export async function removeInboundAgent(input: any, numberId: string): Promise<void> {
  const key = getRasenApiKey(input);
  try {
    await withNumberEtag(key, numberId, (etag) =>
      rasenRequest(key, "DELETE", `/phone-numbers/${enc(numberId)}/assignments/inbound`, { ifMatch: etag })
    );
  } catch (err: any) {
    if (err instanceof RasenError && err.status === 404) return;
    throw err;
  }
}

/** Allow an agent to place OUTBOUND calls from a number (idempotent). */
export async function allowOutboundAgent(input: any, numberId: string, agentId: string): Promise<void> {
  const key = getRasenApiKey(input);
  await withNumberEtag(key, numberId, (etag) =>
    rasenRequest(key, "PUT", `/phone-numbers/${enc(numberId)}/outbound-agents/${enc(agentId)}`, { ifMatch: etag })
  );
}

/**
 * Resolve the number an agent should dial FROM and make sure the agent is linked to it.
 * `from` may be a Rasen number id or an E.164 number; empty = the agent's existing outbound
 * number, else the first outbound-capable number.
 *
 * An explicitly requested caller ID that matches no owned number returns null — we never silently
 * fall back to a different number (that would place calls from the wrong caller ID).
 */
export async function resolveOutboundNumber(
  input: any,
  agentId: string,
  from?: string | null
): Promise<{ id: string; number: string } | null> {
  const key = getRasenApiKey(input);
  const numbers = (await listPhoneNumbers(key)).filter((n) => n?.supports_outbound !== false);
  if (!numbers.length) return null;

  let chosen: any = null;
  if (from && String(from).trim()) {
    const want = String(from).trim();
    chosen = numbers.find((n) => n.id === want) || null;
    if (!chosen) {
      const digits = want.replace(/\D/g, "");
      chosen = digits ? numbers.find((n) => String(n.number || "").replace(/\D/g, "") === digits) || null : null;
    }
    if (!chosen) {
      console.warn(`[voice] requested caller ID does not match any owned number — refusing to fall back to another number`);
      return null;
    }
  } else {
    chosen =
      numbers.find((n) => (n.outbound_primary_agent_ids || []).includes(agentId)) ||
      numbers.find((n) => (n.outbound_agent_ids || []).includes(agentId)) ||
      numbers[0];
  }

  if (!(chosen.outbound_agent_ids || []).includes(agentId)) {
    await allowOutboundAgent(key, chosen.id, agentId);
  }
  return { id: chosen.id, number: chosen.number || "" };
}

// ─── Provider overview ───────────────────────────────────────────────────────

export async function getProviderOverview(input: any): Promise<{
  agents: MappedAgent[];
  phoneNumbers: MappedPhoneNumber[];
  counts: { agents: number; phoneNumbers: number };
}> {
  const [agents, phoneNumbers] = await Promise.all([listMappedAgents(input), listMappedPhoneNumbers(input)]);
  return { agents, phoneNumbers, counts: { agents: agents.length, phoneNumbers: phoneNumbers.length } };
}

// ─── Calls ───────────────────────────────────────────────────────────────────

export interface ListCallsParams {
  agentId?: string;
  campaignId?: string;
  limit?: number;
  /** ISO timestamps. Rasen reads only the last 30 days unless a range is given (max 93 days). */
  start?: string;
  end?: string;
  updatedSince?: string;
  terminal?: boolean;
}

export async function listCalls(input: any, params: ListCallsParams = {}): Promise<any[]> {
  const key = getRasenApiKey(input);
  const query: Record<string, any> = {};
  if (params.agentId) query.agent_id = params.agentId;
  if (params.start) query.start = params.start;
  if (params.end) query.end = params.end;
  if (params.updatedSince) query.updated_since = params.updatedSince;
  if (params.terminal !== undefined) query.terminal = params.terminal;
  if (params.campaignId) { query.metadata_key = "campaign_id"; query.metadata_value = params.campaignId; }
  const max = Math.min(params.limit ?? 100, params.campaignId ? 20_000 : 1000);
  return rasenListAll(key, "/calls", { ...query, limit: Math.min(200, max) }, max);
}

export async function getCall(input: any, callId: string): Promise<any> {
  return (await rasenRequest(getRasenApiKey(input), "GET", `/calls/${enc(callId)}`)).data;
}

async function readOptional<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (err: any) {
    if (err instanceof RasenError && (err.status === 404 || err.status === 409)) return null;
    throw err;
  }
}

/** Every transcript turn of a call (paged), or [] when the transcript is absent / not ready. */
export async function getCallTranscriptTurns(input: any, callId: string): Promise<any[]> {
  const key = getRasenApiKey(input);
  const turns: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const res: RasenResponse<any> | null = await readOptional(() =>
      rasenRequest<any>(key, "GET", `/calls/${enc(callId)}/transcript`, { query: { limit: 200, ...(cursor ? { cursor } : {}) } })
    );
    if (!res || String(res.data?.state || "") !== "ready") break;
    turns.push(...(res.data.items || []));
    cursor = res.data.next_cursor || null;
    if (!cursor) break;
  }
  return turns;
}

export async function getCallSummary(input: any, callId: string): Promise<any | null> {
  const r = await readOptional(() => rasenRequest<any>(getRasenApiKey(input), "GET", `/calls/${enc(callId)}/summary`));
  return r?.data || null;
}

export async function getCallExtraction(input: any, callId: string): Promise<any | null> {
  const r = await readOptional(() => rasenRequest<any>(getRasenApiKey(input), "GET", `/calls/${enc(callId)}/extraction`));
  return r?.data || null;
}

/** Billable telephony seconds of one call from the usage meter (null when not metered yet). */
export async function getCallUsageSeconds(input: any, callId: string): Promise<number | null> {
  const r = await readOptional(() =>
    rasenRequest<any>(getRasenApiKey(input), "GET", "/usage", { query: { call_id: callId, group_by: "call" } })
  );
  const items: any[] = Array.isArray(r?.data?.items) ? r!.data.items : [];
  const seconds = (unit: string, q: number) => (unit === "second" ? q : unit === "minute" ? q * 60 : unit === "millisecond" ? q / 1000 : null);
  const tel = items.find((i) => String(i.component) === "telephony" && seconds(String(i.unit), Number(i.quantity)) != null);
  if (tel) return Math.round(seconds(String(tel.unit), Number(tel.quantity))!);
  // No telephony row (e.g. a browser test call): the longest time-based component is the call length.
  const times = items.map((i) => seconds(String(i.unit), Number(i.quantity))).filter((n): n is number => n != null && n > 0);
  return times.length ? Math.round(Math.max(...times)) : null;
}

/**
 * One call with everything the CRM stores: state + transcript + summary + extraction (+ usage).
 * Result reads are skipped for states that cannot have them, to stay inside the read rate limit.
 */
export async function getMappedCall(
  input: any,
  callId: string,
  opts: { call?: any; extras?: RasenCallExtras; withUsage?: boolean } = {}
): Promise<MappedExecution> {
  const key = getRasenApiKey(input);
  const call = opts.call || (await getCall(key, callId));
  const extras: RasenCallExtras = { ...(opts.extras || {}) };
  if (extras.turns === undefined && String(call.transcript_state || "") === "ready") {
    extras.turns = await getCallTranscriptTurns(key, callId);
  }
  if (extras.summary === undefined && String(call.summary_state || "") === "ready") {
    extras.summary = await getCallSummary(key, callId);
  }
  if (extras.extraction === undefined && String(call.extraction_state || "") === "ready") {
    extras.extraction = await getCallExtraction(key, callId);
  }
  if (opts.withUsage && extras.usageSeconds === undefined && call.terminal) {
    extras.usageSeconds = await getCallUsageSeconds(key, callId).catch(() => null);
  }
  return mapRasenCall(call, extras);
}

/** List calls in the internal shape. List items carry no transcript — `getMappedCall` adds results. */
export async function listMappedCalls(input: any, params: ListCallsParams = {}): Promise<MappedExecution[]> {
  return (await listCalls(input, params)).map((c) => mapRasenCall(c));
}

export interface CreateOutboundCallArgs {
  agentId: string;
  customerNumber: string;
  /** Rasen number id or E.164 to dial from ("" = the agent's outbound number). */
  fromNumber?: string | null;
  customerName?: string;
  /** Per-call variables the prompt can reference (nested objects are flattened). */
  variableValues?: Record<string, any>;
  /** Our own correlation ids, stored on the call (tenant, customer, campaign…). */
  metadata?: Record<string, any>;
  /** Reuse to make a caller-level retry replay the SAME call instead of dialling again. */
  idempotencyKey?: string;
}

export interface OutboundCallResult {
  id: string;
  status: string;
  state: string;
  fromNumberId: string | null;
  fromNumber: string;
  publishedVersionId: string | null;
  pollAfterSeconds: number;
}

/** Build the `POST /calls` body. Pure + deterministic so it is unit-testable. */
export function buildCallPayload(args: CreateOutboundCallArgs & { toE164: string; fromNumberId?: string | null; fromNumberE164?: string }): Record<string, any> {
  const vars: Record<string, any> = { ...(args.variableValues || {}) };
  if (args.customerName && args.customerName.trim()) {
    if (vars.name === undefined) vars.name = args.customerName.trim();
    if (vars.customer_name === undefined) vars.customer_name = args.customerName.trim();
  }
  // The appendix always references these two; send them blank rather than leaving a raw `{{…}}`.
  if (vars.context === undefined) vars.context = "";
  if (vars.profile === undefined) vars.profile = "";
  // Always OUR value: the agent's tools echo it back so a booking lands on the right customer.
  vars.customer_phone = args.toE164;

  const body: Record<string, any> = {
    agent_id: args.agentId,
    to: args.toE164,
    dynamic_variables: toDynamicVariables(vars),
    metadata: toCallMetadata({
      ...(args.metadata || {}),
      to_number: args.toE164,
      ...(args.fromNumberE164 ? { from_number: args.fromNumberE164 } : {}),
      source: (args.metadata as any)?.source || "pine_ai",
    }),
  };
  if (args.fromNumberId) body.from_number_id = args.fromNumberId;
  return body;
}

/**
 * Place a single outbound phone call. Returns once Rasen ADMITS the call (202) — that is not a
 * connected call; the webhook / poller reports the outcome.
 */
export async function createOutboundCall(input: any, args: CreateOutboundCallArgs): Promise<OutboundCallResult> {
  const key = getRasenApiKey(input);
  if (!/^agent_[a-z0-9]+$/i.test(String(args.agentId || ""))) {
    throw new Error(`invalid voice agent id "${args.agentId}" — not a voice agent (stale/corrupt agent reference?)`);
  }
  const to = toE164(args.customerNumber);
  if (!to) throw new Error(`invalid customer phone number "${args.customerNumber}" — must be a full number with country code`);

  const from = await resolveOutboundNumber(key, args.agentId, args.fromNumber || undefined);
  if (!from) {
    throw new Error(
      args.fromNumber
        ? "The selected caller ID is not one of your phone numbers. Pick a valid number or leave it blank."
        : "No outbound phone number is connected to your voice workspace."
    );
  }

  try {
    const res = await rasenRequest<any>(key, "POST", "/calls", {
      body: buildCallPayload({ ...args, toE164: to, fromNumberId: from.id, fromNumberE164: from.number }),
      idempotencyKey: args.idempotencyKey,
      timeoutMs: 45_000,
    });
    return {
      id: res.data.call_id,
      status: "queued",
      state: String(res.data.state || "admitted"),
      fromNumberId: res.data.from_number_id || from.id,
      fromNumber: from.number,
      publishedVersionId: res.data.published_version_id || null,
      pollAfterSeconds: Number(res.data.poll_after_seconds) || 5,
    };
  } catch (err: any) {
    throw new Error(`Voice provider rejected the call: ${describeRasenError(err)}`);
  }
}

/** End one call. Safe to call twice; an already-ended call is a no-op. */
export async function endCall(input: any, callId: string): Promise<{ endRequested: boolean; terminal: boolean }> {
  try {
    const r = await rasenRequest<any>(getRasenApiKey(input), "POST", `/calls/${enc(callId)}/end`);
    return { endRequested: !!r.data?.end_requested, terminal: !!r.data?.terminal };
  } catch (err: any) {
    if (err instanceof RasenError && err.status === 404) return { endRequested: false, terminal: true };
    throw err;
  }
}

/** Best-effort: end every active (non-terminal) call of an agent. */
export async function stopActiveCallsForAgent(input: any, agentId: string): Promise<{ stoppedCalls: number }> {
  const key = getRasenApiKey(input);
  const active = await listCalls(key, { agentId, terminal: false, limit: 1000 });
  let stopped = 0;
  for (const call of active) {
    try {
      const r = await endCall(key, call.id);
      if (r.endRequested) stopped++;
    } catch (err: any) {
      console.warn(`[voice] could not stop call ${call.id}: ${err?.code || err?.status || err?.message}`);
    }
  }
  return { stoppedCalls: stopped };
}

/**
 * Open the recording of a call as a stream (Rasen never returns a storage URL — the audio is
 * streamed through an authenticated endpoint, which our own route then proxies to the browser).
 */
export async function openCallRecording(
  input: any,
  callId: string,
  range?: string
): Promise<{ stream: NodeJS.ReadableStream; status: number; headers: Record<string, any> }> {
  const res = await rasenRequest<any>(getRasenApiKey(input), "GET", `/calls/${enc(callId)}/recording`, {
    responseType: "stream",
    headers: { Accept: "*/*", ...(range ? { Range: range } : {}) },
    timeoutMs: 120_000,
    maxAttempts: 1,
  });
  return { stream: res.data, status: res.status, headers: res.headers };
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

export interface CampaignRecipient { to_e164: string; contact_ref?: string; variables?: Record<string, string> }

/**
 * Parse the app's campaign CSV (contact_number,first_name,full_name,history,status,…) into Rasen
 * recipients. Extra columns become per-recipient variables. Rows without a valid number are
 * dropped and counted, never sent malformed.
 */
export function csvToRecipients(csvBuffer: Buffer): { recipients: CampaignRecipient[]; skipped: number } {
  const rows: Record<string, string>[] = parseCsv(csvBuffer.toString("utf-8"), { columns: true, skip_empty_lines: true, trim: true });
  const seen = new Set<string>();
  const recipients: CampaignRecipient[] = [];
  let skipped = 0;
  for (const row of rows) {
    const to = toE164(row.contact_number || row.number || row.phone || row.phoneNumber || "");
    if (!to || seen.has(to)) { skipped++; continue; }
    seen.add(to);
    const vars: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      if (["contact_number", "number", "phone", "phoneNumber"].includes(k) || v == null || v === "") continue;
      vars[k] = String(v);
    }
    if (vars.name === undefined && (row.full_name || row.first_name)) vars.name = row.full_name || row.first_name;
    if (vars.context === undefined) vars.context = row.history || "";
    if (vars.profile === undefined) vars.profile = "";
    const rec: CampaignRecipient = { to_e164: to, variables: toDynamicVariables(vars) };
    const ref = row.customer_id || row.contact_ref || row.id;
    if (ref) rec.contact_ref = String(ref).slice(0, 200);
    recipients.push(rec);
  }
  return { recipients, skipped };
}

export interface CampaignOptions {
  fromNumber?: string | null;
  maxAttemptsPerRecipient?: number;
  maxConcurrentCalls?: number;
  timeZone?: string;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  dailyOpensMinute?: number | null;
  dailyClosesMinute?: number | null;
  /** false = create + plan only (a scheduled campaign started later). Default true. */
  start?: boolean;
}

async function campaignCommand(key: string, campaignId: string, command: string, body?: any): Promise<any> {
  const cur = await rasenRequest<any>(key, "GET", `/campaigns/${enc(campaignId)}`);
  const res = await rasenRequest<any>(key, "POST", `/campaigns/${enc(campaignId)}/${command}`, {
    ifMatch: cur.etag || cur.data?.revision || undefined,
    body,
    timeoutMs: 60_000,
  });
  return res.data;
}

/**
 * Create a Rasen campaign from the app's lead CSV and (by default) run it:
 * create → plan → admit → start. Each step is a separate Rasen command.
 */
export async function createCampaignFromCsv(
  input: any,
  agentId: string,
  csvBuffer: Buffer,
  filename = "campaign.csv",
  opts: CampaignOptions = {}
): Promise<{ id: string; status: string; recipient_count: number; skipped: number; [k: string]: any }> {
  const key = getRasenApiKey(input);
  const { recipients, skipped } = csvToRecipients(csvBuffer);
  if (!recipients.length) throw new Error("No valid recipients found in campaign CSV");

  const from = await resolveOutboundNumber(key, agentId, opts.fromNumber || undefined);
  if (!from) {
    throw new Error(
      opts.fromNumber
        ? "The selected caller ID is not one of your phone numbers. Pick a valid number or leave it blank."
        : "No outbound phone number is connected to your voice workspace. Ask your admin to connect one."
    );
  }

  const body: Record<string, any> = {
    agent_id: agentId,
    name: filename.replace(/\.csv$/i, "").slice(0, 200) || "Campaign",
    recipients,
    from_phone_number_id: from.id,
    ...(opts.maxAttemptsPerRecipient ? { max_attempts_per_recipient: opts.maxAttemptsPerRecipient } : {}),
    ...(opts.maxConcurrentCalls ? { max_concurrent_calls: opts.maxConcurrentCalls } : {}),
    ...(opts.timeZone ? { dialing_time_zone: opts.timeZone } : {}),
    ...(opts.windowStartAt ? { window_start_at: opts.windowStartAt } : {}),
    ...(opts.windowEndAt ? { window_end_at: opts.windowEndAt } : {}),
    ...(opts.dailyOpensMinute != null ? { daily_opens_minute: opts.dailyOpensMinute } : {}),
    ...(opts.dailyClosesMinute != null ? { daily_closes_minute: opts.dailyClosesMinute } : {}),
  };
  const created = (await rasenRequest<any>(key, "POST", "/campaigns", { body, timeoutMs: 120_000 })).data;

  let state = created.state;
  if (opts.start !== false) {
    for (const cmd of ["plan", "admit", "start"]) {
      const r = await campaignCommand(key, created.id, cmd);
      state = r?.state || state;
    }
  }
  return { ...created, id: created.id, status: state, state, recipient_count: created.recipient_count ?? recipients.length, skipped };
}

export async function getCampaign(input: any, campaignId: string): Promise<{ id: string; status: string; created_at?: string; [k: string]: any }> {
  const res = await rasenRequest<any>(getRasenApiKey(input), "GET", `/campaigns/${enc(campaignId)}`);
  return { ...res.data, status: res.data?.state };
}

/** Start a campaign that was created with `start: false` (plan → admit → start; replays are safe). */
export async function startCampaign(input: any, campaignId: string): Promise<any> {
  const key = getRasenApiKey(input);
  let last: any = null;
  for (const cmd of ["plan", "admit", "start"]) {
    try { last = await campaignCommand(key, campaignId, cmd); }
    catch (err: any) {
      // A step that is already done answers a state conflict — move on to the next step.
      if (err instanceof RasenError && err.status === 409 && cmd !== "start") continue;
      throw err;
    }
  }
  return { ...last, status: last?.state };
}

export async function pauseCampaign(input: any, campaignId: string): Promise<any> {
  const r = await campaignCommand(getRasenApiKey(input), campaignId, "pause");
  return { ...r, status: r?.state };
}

export async function resumeCampaign(input: any, campaignId: string): Promise<any> {
  const r = await campaignCommand(getRasenApiKey(input), campaignId, "resume");
  return { ...r, status: r?.state };
}

/** Stop a campaign for good. Already-finished campaigns are a no-op. */
export async function cancelCampaign(input: any, campaignId: string): Promise<any> {
  try {
    const r = await campaignCommand(getRasenApiKey(input), campaignId, "cancel");
    return { ...r, status: r?.state };
  } catch (err: any) {
    if (err instanceof RasenError && err.status === 409) return getCampaign(input, campaignId);
    throw err;
  }
}

/** Per-recipient progress of a campaign (attempt state, last call id, outcome). */
export async function listCampaignRecipients(input: any, campaignId: string, max = 20_000): Promise<any[]> {
  return rasenListAll(getRasenApiKey(input), `/campaigns/${enc(campaignId)}/recipients`, {}, max);
}

/** Add a number to the workspace suppression list so no campaign dials it again (opt-out / DNC). */
export async function suppressDestination(input: any, number: string, reason = "opt_out"): Promise<void> {
  const to = toE164(number);
  if (!to) return;
  try {
    await rasenRequest(getRasenApiKey(input), "POST", "/campaign-suppressions", { body: { to_e164: to, reason } });
  } catch (err: any) {
    if (err instanceof RasenError && err.status === 409) return; // already suppressed
    throw err;
  }
}

// ─── Usage (for billing: quantities only, never a price) ─────────────────────

export interface UsageRow { component: string; unit: string; quantity: number; agentId: string | null; callId: string | null; events: number }

export async function getUsage(
  input: any,
  params: { start?: string; end?: string; agentId?: string; callId?: string; groupBy?: Array<"agent" | "call"> } = {}
): Promise<{ state: string; rows: UsageRow[]; range: { start: string; end: string } | null }> {
  const key = getRasenApiKey(input);
  const rows: UsageRow[] = [];
  let cursor: string | null = null;
  let state = "empty";
  let range: any = null;
  for (let page = 0; page < 50; page++) {
    const res: RasenResponse<any> = await rasenRequest(key, "GET", "/usage", {
      query: {
        start: params.start, end: params.end, agent_id: params.agentId, call_id: params.callId,
        group_by: params.groupBy, limit: 200, ...(cursor ? { cursor } : {}),
      },
    });
    state = String(res.data?.state || state);
    range = res.data?.range || range;
    for (const i of res.data?.items || []) {
      rows.push({ component: i.component, unit: i.unit, quantity: Number(i.quantity) || 0, agentId: i.agent_id || null, callId: i.call_id || null, events: Number(i.events) || 0 });
    }
    cursor = res.data?.next_cursor || null;
    if (!cursor) break;
  }
  return { state, rows, range };
}

// ─── Webhook endpoints ───────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = ["call.completed", "call.failed", "call.analyzed"] as const;

/**
 * Make sure the workspace delivers call events to `url`. Returns the signing secret ONLY when a
 * new endpoint was created (Rasen shows a secret once); an existing endpoint returns `secret: null`
 * and the caller keeps the secret it stored when the endpoint was first created.
 */
export async function ensureWebhookEndpoint(
  input: any,
  url: string
): Promise<{ id: string; created: boolean; secret: string | null; events: string[]; state: string }> {
  const key = getRasenApiKey(input);
  const existing = (await rasenListAll(key, "/webhook-endpoints", {}, 50)).find(
    (e: any) => String(e.url).replace(/\/+$/, "") === url.replace(/\/+$/, "") && !e.deleted_at
  );
  if (existing) {
    const missing = WEBHOOK_EVENTS.filter((e) => !(existing.events || []).includes(e));
    if (missing.length || existing.state !== "enabled") {
      await rasenRequest(key, "PUT", `/webhook-endpoints/${enc(existing.id)}`, {
        ifMatch: existing.revision,
        body: { url: existing.url, description: existing.description || "Pine AI call events", events: [...WEBHOOK_EVENTS], state: "enabled" },
      }).catch((err: any) => console.warn(`[voice] could not update webhook endpoint ${existing.id}: ${describeRasenError(err)}`));
    }
    return { id: existing.id, created: false, secret: null, events: existing.events || [], state: existing.state };
  }
  const res = await rasenRequest<any>(key, "POST", "/webhook-endpoints", {
    body: { url, description: "Pine AI call events", events: [...WEBHOOK_EVENTS] },
  });
  return { id: res.data.id, created: true, secret: res.data.secret || null, events: res.data.events || [], state: res.data.state };
}

/** Ask Rasen to send a signed `webhook.test` event to one endpoint. */
export async function sendWebhookTest(input: any, endpointId: string): Promise<any> {
  return (await rasenRequest<any>(getRasenApiKey(input), "POST", `/webhook-endpoints/${enc(endpointId)}/test`)).data;
}

// ─── Browser test call (hosted share link) ───────────────────────────────────

/**
 * Enable the agent's hosted test-call link and return its one-time token. Rasen has no browser
 * SDK: the web "talk to the agent" experience is this hosted link. The token is revealed only by
 * the write that issues it, so an already-enabled link is rotated to obtain a fresh one.
 */
export async function issueTestCallToken(input: any, agentId: string): Promise<{ token: string | null; tokenPrefix: string | null; expiresAt: string | null; canShare: boolean }> {
  const key = getRasenApiKey(input);
  const cur = await rasenRequest<any>(key, "GET", `/agents/${enc(agentId)}/share-link`);
  if (cur.data?.can_share === false) return { token: null, tokenPrefix: null, expiresAt: null, canShare: false };
  const write = cur.data?.enabled
    ? await rasenRequest<any>(key, "POST", `/agents/${enc(agentId)}/share-link/rotate`, { ifMatch: cur.etag })
    : await rasenRequest<any>(key, "PUT", `/agents/${enc(agentId)}/share-link`, { ifMatch: cur.etag, body: { enabled: true } });
  return {
    token: write.data?.token || null,
    tokenPrefix: write.data?.token_prefix || null,
    expiresAt: write.data?.expires_at || null,
    canShare: true,
  };
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

/** Add a block of text to an agent's knowledge library (ingested asynchronously), keyed so a re-push replaces it. */
export async function addAgentKnowledgeText(input: any, agentId: string, name: string, text: string, resourceKey?: string): Promise<any> {
  const body: Record<string, any> = { type: "text", name: name.slice(0, 200), text };
  if (resourceKey) body.resource_key = resourceKey;
  return (await rasenRequest<any>(getRasenApiKey(input), "POST", `/agents/${enc(agentId)}/knowledge/sources`, { body, timeoutMs: 60_000 })).data;
}

export async function uploadAgentKnowledgeFile(input: any, agentId: string, name: string, file: Buffer, filename: string): Promise<any> {
  const form = new FormData();
  form.append("name", name.slice(0, 200));
  form.append("file", file, { filename });
  return (await rasenRequest<any>(getRasenApiKey(input), "POST", `/agents/${enc(agentId)}/knowledge/sources/upload`, {
    body: form, headers: form.getHeaders(), timeoutMs: 120_000,
  })).data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function enc(v: string): string {
  return encodeURIComponent(String(v));
}

/** A safe, human-readable reason for a provider failure (never includes the key). */
export function describeRasenError(err: any): string {
  if (err instanceof RasenError) {
    const d = err.details || {};
    const extra = [d.reason, d.field && `field ${d.field}`, d.name && `(${d.name})`].filter(Boolean).join(" ");
    const id = err.requestId ? ` [${err.requestId}]` : "";
    return `${err.code}${extra ? ` — ${extra}` : ""}: ${err.message}${id}`.slice(0, 600);
  }
  return String(err?.message || err).slice(0, 600);
}

/** True when the failure is the provider telling us to slow down / come back later. */
export function isRasenBackpressure(err: any): boolean {
  return err instanceof RasenError && (err.status === 429 || err.status === 503 || err.code === "rate_limited" || err.code === "quota_exceeded" || err.code === "at_capacity");
}
