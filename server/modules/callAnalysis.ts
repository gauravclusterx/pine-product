/**
 * AI call analysis — the CRM's analyzeTranscript: when the agent's own extraction gave no usable
 * outcome (an agent synced from the Rasen workspace has its own fields, or the model skipped one),
 * the transcript is classified with the admin-set AI key into our outcome vocabulary, with the
 * customer's name and a next step. The contact's status follows (unless a person set it).
 */
import { one, q } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { aiAvailable, chatFor, type ChatFn } from "./ai.js";
import { setStatusFromCall } from "./customers.js";

export const OUTCOMES = ["booked", "callback", "quote", "info", "not_interested", "no_contact", "transferred", "opt_out"] as const;

const SYSTEM = `You analyse phone calls between a business's AI agent and a customer. Reply with JSON only:
{"outcome": one of ${OUTCOMES.map((o) => `"${o}"`).join(", ")},
 "customer_name": the customer's name if they said it, else "",
 "next_step": one short sentence, or "",
 "sentiment": "positive" | "neutral" | "negative",
 "summary": two sentences}
"booked" only when a visit, job or meeting was actually agreed. "callback" when they asked to be called later.`;

export function parseAnalysis(text: string): { outcome: string; customer_name: string; next_step: string; sentiment: string; summary: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const outcome = (OUTCOMES as readonly string[]).includes(j.outcome) ? j.outcome : null;
    if (!outcome) return null;
    return { outcome, customer_name: String(j.customer_name || "").slice(0, 80), next_step: String(j.next_step || "").slice(0, 300), sentiment: ["positive", "neutral", "negative"].includes(j.sentiment) ? j.sentiment : "neutral", summary: String(j.summary || "").slice(0, 600) };
  } catch { return null; }
}

/** Classify a finished call that has a transcript but no usable outcome. */
export async function analyseCall(callId: string, chat?: ChatFn): Promise<boolean> {
  const c = await one("SELECT id, org_id, customer_id, outcome, transcript, summary, extraction FROM calls WHERE id = $1", [callId]);
  if (!c) return false;
  const lines: string[] = Array.isArray(c.transcript) ? c.transcript : [];
  if (lines.length < 2 || (c.outcome && c.outcome !== "unknown")) return false;
  if (!(await aiAvailable(c.org_id))) return false;
  try {
    const r = await chatFor(c.org_id, { system: SYSTEM, messages: [{ role: "user", content: lines.join("\n").slice(0, 20_000) }], maxTokens: 1500 }, chat);
    const a = parseAnalysis(r.text);
    if (!a) return false;
    const extraction = { ...(c.extraction || {}), outcome: a.outcome, sentiment: (c.extraction || {}).sentiment || a.sentiment, next_step: a.next_step, analysed_by: `${r.provider}:${r.model}` };
    await q("UPDATE calls SET outcome = $2, extraction = $3, summary = CASE WHEN summary = '' THEN $4 ELSE summary END, updated_at = now() WHERE id = $1", [c.id, a.outcome, JSON.stringify(extraction), a.summary]);
    if (c.customer_id) {
      await setStatusFromCall(c.customer_id, a.outcome);
      if (a.customer_name) await q("UPDATE customers SET name = $2, updated_at = now() WHERE id = $1 AND name = ''", [c.customer_id, a.customer_name]);
    }
    return true;
  } catch (err) {
    log.warn({ callId, err: (err as Error).message }, "call analysis failed");
    return false;
  }
}
