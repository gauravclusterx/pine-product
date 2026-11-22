/**
 * AI providers, the CRM way ("AI keys" in the admin panel): an OpenAI key + model and an Anthropic
 * key + model, set platform-wide (Admin → Settings) and optionally per customer (Admin → Customers).
 * Keys are stored encrypted and never returned — only whether one is set and its last four characters.
 *
 * Order tried for a customer: its OpenAI key → its Anthropic key → platform OpenAI → platform
 * Anthropic → OPENAI_API_KEY from the server env. A provider that fails falls through to the next.
 * Used by: the SMS agent (AI replies) and "Translate to English" on transcripts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { one, q } from "../db/pool.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { log } from "../lib/logger.js";

export type Provider = "openai" | "anthropic";
export const OPENAI_MODELS = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"];
export const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export const looksLikeKey = (p: Provider, k: string) => (p === "openai" ? /^sk-(?!ant-)[A-Za-z0-9_\-]{20,}$/ : /^sk-ant-[A-Za-z0-9_\-]{20,}$/).test(k.trim());
const MODEL_RE = /^[A-Za-z0-9._:\-]{2,80}$/;

export interface ProviderStatus { set: boolean; last4: string | null; model: string }
export interface KeyStatus { openai: ProviderStatus; anthropic: ProviderStatus }

const tail = (enc: string | null) => { if (!enc) return null; try { return decrypt(enc).slice(-4); } catch { return null; } };
const plain = (enc: string | null) => { if (!enc) return ""; try { return decrypt(enc); } catch { return ""; } };

async function settingsRow() {
  return (await one("SELECT * FROM app_settings WHERE id")) || (await one("INSERT INTO app_settings (id) VALUES (true) ON CONFLICT (id) DO UPDATE SET id = true RETURNING *"))!;
}

export async function platformKeyStatus(): Promise<KeyStatus & { serverKey: boolean }> {
  const s = await settingsRow();
  return {
    openai: { set: !!s.openai_key_enc, last4: tail(s.openai_key_enc), model: s.openai_model },
    anthropic: { set: !!s.anthropic_key_enc, last4: tail(s.anthropic_key_enc), model: s.anthropic_model },
    serverKey: looksLikeKey("openai", config.OPENAI_API_KEY),
  };
}

export async function orgKeyStatus(orgId: string): Promise<KeyStatus & { usesPlatform: boolean }> {
  const o = await one("SELECT openai_key_enc, openai_model, anthropic_key_enc, anthropic_model FROM orgs WHERE id = $1", [orgId]);
  if (!o) throw new HttpError(404, "not_found", "Workspace not found");
  const p = await platformKeyStatus();
  return {
    openai: { set: !!o.openai_key_enc, last4: tail(o.openai_key_enc), model: o.openai_model || p.openai.model },
    anthropic: { set: !!o.anthropic_key_enc, last4: tail(o.anthropic_key_enc), model: o.anthropic_model || p.anthropic.model },
    usesPlatform: !o.openai_key_enc && !o.anthropic_key_enc && (p.openai.set || p.anthropic.set || p.serverKey),
  };
}

export interface KeyPatch { openaiKey?: string | null; openaiModel?: string | null; anthropicKey?: string | null; anthropicModel?: string | null }

function validate(p: KeyPatch) {
  if (p.openaiKey && !looksLikeKey("openai", p.openaiKey)) throw new HttpError(400, "bad_key", "That is not an OpenAI key (it starts with sk-).");
  if (p.anthropicKey && !looksLikeKey("anthropic", p.anthropicKey)) throw new HttpError(400, "bad_key", "That is not an Anthropic key (it starts with sk-ant-).");
  for (const m of [p.openaiModel, p.anthropicModel]) if (m && !MODEL_RE.test(m)) throw new HttpError(400, "bad_model", "That model name is not valid.");
}

/** undefined = leave as is; null or "" = remove (keys) / reset to default (models). */
function sets(p: KeyPatch, start: number, modelDefaults: boolean): { sql: string[]; vals: unknown[] } {
  const sql: string[] = [], vals: unknown[] = [];
  const add = (col: string, v: unknown) => { vals.push(v); sql.push(`${col} = $${start + vals.length}`); };
  if (p.openaiKey !== undefined) add("openai_key_enc", p.openaiKey ? encrypt(p.openaiKey.trim()) : null);
  if (p.anthropicKey !== undefined) add("anthropic_key_enc", p.anthropicKey ? encrypt(p.anthropicKey.trim()) : null);
  if (p.openaiModel !== undefined) add("openai_model", p.openaiModel || (modelDefaults ? "gpt-4o-mini" : null));
  if (p.anthropicModel !== undefined) add("anthropic_model", p.anthropicModel || (modelDefaults ? "claude-opus-5-5" : null));
  return { sql, vals };
}

export async function setPlatformKeys(p: KeyPatch): Promise<void> {
  validate(p);
  await settingsRow();
  const { sql, vals } = sets(p, 0, true);
  if (sql.length) await q(`UPDATE app_settings SET ${sql.join(", ")}, updated_at = now() WHERE id`, vals);
}

export async function setOrgKeys(orgId: string, p: KeyPatch): Promise<void> {
  validate(p);
  const { sql, vals } = sets(p, 1, false);
  if (!sql.length) return;
  const r = await one(`UPDATE orgs SET ${sql.join(", ")} WHERE id = $1 RETURNING id`, [orgId, ...vals]);
  if (!r) throw new HttpError(404, "not_found", "Workspace not found");
}

export interface Credential { provider: Provider; key: string; model: string; scope: "customer" | "platform" | "server" }

/** Every usable credential for this customer, in the order they are tried. */
export async function credentialsFor(orgId: string | null): Promise<Credential[]> {
  const out: Credential[] = [];
  const s = await settingsRow();
  if (orgId) {
    const o = await one("SELECT openai_key_enc, openai_model, anthropic_key_enc, anthropic_model FROM orgs WHERE id = $1", [orgId]);
    if (o?.openai_key_enc && plain(o.openai_key_enc)) out.push({ provider: "openai", key: plain(o.openai_key_enc), model: o.openai_model || s.openai_model, scope: "customer" });
    if (o?.anthropic_key_enc && plain(o.anthropic_key_enc)) out.push({ provider: "anthropic", key: plain(o.anthropic_key_enc), model: o.anthropic_model || s.anthropic_model, scope: "customer" });
  }
  if (s.openai_key_enc && plain(s.openai_key_enc)) out.push({ provider: "openai", key: plain(s.openai_key_enc), model: s.openai_model, scope: "platform" });
  if (s.anthropic_key_enc && plain(s.anthropic_key_enc)) out.push({ provider: "anthropic", key: plain(s.anthropic_key_enc), model: s.anthropic_model, scope: "platform" });
  if (looksLikeKey("openai", config.OPENAI_API_KEY)) out.push({ provider: "openai", key: config.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || s.openai_model, scope: "server" });
  return out;
}

export async function aiAvailable(orgId: string | null): Promise<boolean> {
  return (await credentialsFor(orgId)).length > 0;
}

export type ChatMessage = { role: "user" | "assistant"; content: string };
export interface ChatRequest { system: string; messages: ChatMessage[]; maxTokens?: number }
export type ChatFn = (cred: Credential, req: ChatRequest) => Promise<string>;

async function openAiChat(cred: Credential, req: ChatRequest): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cred.key}` },
    body: JSON.stringify({ model: cred.model, messages: [{ role: "system", content: req.system }, ...req.messages], max_completion_tokens: req.maxTokens ?? 1200 }),
    signal: AbortSignal.timeout(60_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${data?.error?.message || "error"}`);
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

/** Anthropic needs the conversation to start with a user turn and alternate; merge same-role runs. */
function anthropicMessages(msgs: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.length ? out : [{ role: "user", content: "(no message)" }];
}

async function anthropicChat(cred: Credential, req: ChatRequest): Promise<string> {
  const client = new Anthropic({ apiKey: cred.key, timeout: 60_000, maxRetries: 1 });
  const res = await client.messages.create({
    model: cred.model,
    max_tokens: Math.max(req.maxTokens ?? 1200, 4000),
    system: req.system,
    messages: anthropicMessages(req.messages),
  });
  if (res.stop_reason === "refusal") throw new Error("Anthropic declined this request");
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}

export const providerChat: ChatFn = (cred, req) => (cred.provider === "openai" ? openAiChat(cred, req) : anthropicChat(cred, req));

/** Ask the first credential that works. Throws when none is set or all fail. */
export async function chatFor(orgId: string | null, req: ChatRequest, chat: ChatFn = providerChat): Promise<{ text: string; provider: Provider; model: string }> {
  const creds = await credentialsFor(orgId);
  if (!creds.length) throw new HttpError(409, "ai_off", "No AI key is set — your Pine AI admin adds one in the admin panel.");
  let last: Error | null = null;
  for (const c of creds) {
    try {
      const text = await chat(c, req);
      if (text) return { text, provider: c.provider, model: c.model };
    } catch (err) {
      last = err as Error;
      log.warn({ orgId, provider: c.provider, scope: c.scope, err: last.message }, "AI provider failed, trying the next");
    }
  }
  throw new HttpError(502, "ai_failed", `AI did not answer: ${last?.message || "empty reply"}`);
}

/** Admin "Save": a key is checked with its provider before it is stored. */
export async function testKey(provider: Provider, key: string, model: string, chat: ChatFn = providerChat): Promise<void> {
  const text = await chat({ provider, key, model, scope: "platform" }, { system: "You are a connectivity check.", messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 50 });
  if (!text) throw new Error("empty reply");
}
