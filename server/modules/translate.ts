/**
 * "Translate to English" for call transcripts. Speech-to-text keeps each speaker's own language
 * (Hindi in Devanagari, Spanish, Hinglish…); office staff read it in English. Speaker labels and
 * line order are kept. Cached on the call, so a transcript is translated once.
 * Uses the AI keys set in the admin panel (OpenAI or Anthropic, per customer or platform-wide).
 */
import { one, q } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import { aiAvailable, chatFor, type ChatFn } from "./ai.js";

export async function translationAvailable(orgId: string | null = null): Promise<boolean> {
  return aiAvailable(orgId);
}

const SYSTEM =
  "Translate this phone-call transcript into natural English. Keep every line, in order, with its speaker label exactly as given " +
  "(e.g. 'AI:' or 'Customer:'). Lines already in English stay unchanged. Keep names, numbers, dates and times exactly. Output only the transcript.";

export async function translateCall(orgId: string, callId: string, opts: { refresh?: boolean; chat?: ChatFn } = {}): Promise<{ lines: string[]; cached: boolean }> {
  const c = await one("SELECT transcript, qa FROM calls WHERE org_id = $1 AND id = $2", [orgId, callId]);
  if (!c) throw notFound("Call not found.");
  const cached = c.qa?.transcriptEn;
  if (Array.isArray(cached) && cached.length && !opts.refresh) return { lines: cached, cached: true };
  const lines: string[] = Array.isArray(c.transcript) ? c.transcript : [];
  if (!lines.length) throw new HttpError(400, "no_transcript", "This call has no transcript.");
  const r = await chatFor(orgId, { system: SYSTEM, messages: [{ role: "user", content: lines.join("\n").slice(0, 24_000) }], maxTokens: 6000 }, opts.chat);
  const out = r.text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!out.length) throw new HttpError(502, "translation_failed", "The translation came back empty. Try again.");
  await q("UPDATE calls SET qa = qa || $3, updated_at = now() WHERE org_id = $1 AND id = $2", [orgId, callId, JSON.stringify({ transcriptEn: out })]);
  return { lines: out, cached: false };
}
