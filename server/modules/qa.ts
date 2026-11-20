/**
 * Call scoring and coaching. Every finished call gets a 0–100 score with a per-skill breakdown,
 * computed from the transcript and the provider's post-call extraction. The rules are explicit
 * (and tested) so a client can see exactly why a call scored what it did.
 *
 * "Second chance": a call where the customer wanted service but nothing was booked is flagged,
 * so the office (or a callback) can recover the job.
 */

export interface Turn { speaker: "AI" | "Customer"; text: string }

export interface QaResult {
  score: number;
  breakdown: { greeting: number; discovery: number; booking: number; courtesy: number };
  flags: string[];
  coaching: string[];
  secondChance: boolean;
}

/** Split the provider transcript text ("AI: …\nCustomer: …") into turns. */
export function parseTranscript(text: string): Turn[] {
  const out: Turn[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(AI|Agent|Assistant|Customer|User|Caller)\s*:\s*(.*)$/i.exec(line);
    if (m) out.push({ speaker: /^(AI|Agent|Assistant)$/i.test(m[1]) ? "AI" : "Customer", text: m[2].trim() });
    else if (out.length && line.trim()) out[out.length - 1].text += " " + line.trim();
  }
  return out.filter((t) => t.text);
}

const INTEREST = /\b(book|schedule|appointment|come out|send (someone|a tech)|repair|fix|quote|estimate|install|replace|not (working|cooling|heating)|leak|broken|emergency|today|tomorrow|asap)\b/i;
const COURTESY = /\b(thank|thanks|appreciate|sorry|apolog|happy to help|you're welcome|have a (great|good|nice))\b/i;
const QUESTION = /\?\s*$/;

export function scoreCall(input: { transcript: string; outcome: string | null; extraction: Record<string, any>; durationSeconds: number; businessName: string }): QaResult | null {
  const turns = parseTranscript(input.transcript);
  const ai = turns.filter((t) => t.speaker === "AI");
  const customer = turns.filter((t) => t.speaker === "Customer");
  // Nobody spoke (no answer, voicemail): nothing to coach.
  if (!customer.length || input.durationSeconds < 10) return null;

  const flags: string[] = [];
  const coaching: string[] = [];
  const outcome = String(input.outcome || input.extraction?.outcome || "unknown");

  // Greeting (25): says who and which business in the first turn.
  const first = (ai[0]?.text || "").toLowerCase();
  const bizWord = input.businessName.toLowerCase().split(/\s+/).find((w) => w.length > 3) || input.businessName.toLowerCase();
  let greeting = 10;
  if (first) greeting += 5;
  if (bizWord && first.includes(bizWord)) greeting += 10;
  else coaching.push("Name the business in the first sentence.");

  // Discovery (25): asks questions, lets the customer talk.
  const questions = ai.filter((t) => QUESTION.test(t.text)).length;
  const aiWords = ai.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  const custWords = customer.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  const talkShare = aiWords / Math.max(1, aiWords + custWords);
  let discovery = Math.min(15, questions * 5);
  if (talkShare <= 0.65) discovery += 10;
  else { discovery += 3; coaching.push("Talk less, ask more — the agent spoke for most of the call."); }
  // The same question asked again and again means the agent was stuck.
  const repeats = ai.length - new Set(ai.map((t) => t.text.toLowerCase().replace(/[^a-z ]/g, "").slice(0, 60))).size;
  if (repeats >= 2) { discovery = Math.max(0, discovery - 10); flags.push("repeated_questions"); coaching.push("The agent repeated itself; check the tool answers for that part of the call."); }

  // Booking (35): the job of almost every call.
  const interested = customer.some((t) => INTEREST.test(t.text)) || /book|callback|quote/.test(outcome);
  let booking = 0;
  if (outcome === "booked") booking = 35;
  else if (outcome === "callback" || outcome === "quote") booking = 20;
  else if (outcome === "transferred") booking = 25;
  else if (!interested) booking = 25; // nothing to book (wrong number, info call)
  else booking = 5;
  const secondChance = interested && !["booked", "transferred", "opt_out"].includes(outcome);
  if (secondChance) { flags.push("missed_booking"); coaching.push("The customer wanted service but nothing was booked — call them back."); }

  // Courtesy (15).
  let courtesy = ai.some((t) => COURTESY.test(t.text)) ? 10 : 3;
  if (String(input.extraction?.sentiment || "") === "negative") { courtesy = Math.max(0, courtesy - 5); flags.push("unhappy_customer"); }
  else courtesy += 5;

  const score = Math.max(0, Math.min(100, Math.round(greeting + discovery + booking + courtesy)));
  return { score, breakdown: { greeting, discovery, booking, courtesy }, flags, coaching, secondChance };
}
