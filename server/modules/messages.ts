/**
 * The text side of a contact's conversation (SMS), both directions. Voice calls live in `calls`;
 * conversationFor() merges both into one timeline for the customer view, like the CRM.
 */
import { one, q } from "../db/pool.js";

export type Author = "agent" | "human" | "system" | "customer";

export async function recordMessage(m: {
  orgId: string; phone: string; direction: "in" | "out"; body: string; author: Author;
  status: "sent" | "failed" | "received"; providerId?: string | null; error?: string | null;
}): Promise<string> {
  const c = await one("SELECT id FROM customers WHERE org_id = $1 AND phone_e164 = $2", [m.orgId, m.phone]);
  const r = await one(
    `INSERT INTO messages (org_id, customer_id, phone_e164, direction, author, body, status, provider_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [m.orgId, c?.id ?? null, m.phone, m.direction, m.author, m.body.slice(0, 2000), m.status, m.providerId ?? null, m.error ?? null]
  );
  if (c) await q("UPDATE customers SET updated_at = now() WHERE id = $1", [c.id]);
  return r!.id;
}

/** Calls and messages with one contact, newest first. */
export async function conversationFor(orgId: string, customerId: string, limit = 200) {
  const c = await one("SELECT phone_e164 FROM customers WHERE org_id = $1 AND id = $2", [orgId, customerId]);
  if (!c) return null;
  const calls = await q(
    `SELECT x.id, x.direction, x.status, x.started_at AS at, x.duration_seconds, x.outcome, x.summary, x.transcript, x.extraction,
            x.recording_available, x.qa_score, x.ended_reason, a.name AS agent_name
     FROM calls x LEFT JOIN agents a ON a.id = x.agent_id
     WHERE x.org_id = $1 AND (x.customer_id = $2 OR x.phone_e164 = $3) ORDER BY x.started_at DESC LIMIT $4`,
    [orgId, customerId, c.phone_e164, limit]
  );
  const messages = await q(
    `SELECT id, direction, author, body, status, error, created_at AS at FROM messages
     WHERE org_id = $1 AND (customer_id = $2 OR phone_e164 = $3) ORDER BY created_at DESC LIMIT $4`,
    [orgId, customerId, c.phone_e164, limit]
  );
  const items = [
    ...calls.map((x) => ({ type: "call" as const, ...x })),
    ...messages.map((m) => ({ type: "sms" as const, ...m })),
  ].sort((a: any, b: any) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { items, calls: calls.length, messages: messages.length };
}
