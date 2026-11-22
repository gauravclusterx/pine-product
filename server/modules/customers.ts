/**
 * Customers and per-customer memory.
 *
 * Memory ("RAG per customer"): before every call the agent is given what the business knows
 * about this person — the name on file, address, notes, membership and open estimates from the
 * CRM, upcoming jobs, and what was said on earlier calls. It travels as call variables
 * (`customer_name`, `profile`, `context`) that every agent prompt renders (voice/agentPrompt.ts),
 * so the agent never asks for a name it already has and can pick up where the last call ended.
 */
import { one, q, Q } from "../db/pool.js";
import { speakTime } from "../lib/time.js";
import type { Org } from "./orgs.js";

export interface Customer {
  id: string; orgId: string; name: string; phone: string; email: string; address: Record<string, any>;
  externalId: string | null; connector: string | null; notes: string; consentAt: Date | null; consentSource: string | null;
  crmSnapshot: Record<string, any>; createdAt: Date;
  stage: "lead" | "customer"; status: string; statusLocked: boolean; tags: string[]; source: string; updatedAt: Date;
}

export function toCustomer(r: any): Customer {
  return {
    id: r.id, orgId: r.org_id, name: r.name, phone: r.phone_e164, email: r.email, address: r.address || {},
    externalId: r.external_id, connector: r.connector, notes: r.notes, consentAt: r.consent_at, consentSource: r.consent_source,
    crmSnapshot: r.crm_snapshot || {}, createdAt: r.created_at,
    stage: r.stage || "lead", status: r.status || "fresh", statusLocked: !!r.status_locked, tags: r.tags || [], source: r.source || "", updatedAt: r.updated_at,
  };
}

export async function findCustomerByPhone(orgId: string, phone: string, run: Q = q): Promise<Customer | null> {
  const rows = await run("SELECT * FROM customers WHERE org_id = $1 AND phone_e164 = $2", [orgId, phone]);
  return rows[0] ? toCustomer(rows[0]) : null;
}

export async function getCustomer(orgId: string, id: string): Promise<Customer | null> {
  const r = await one("SELECT * FROM customers WHERE org_id = $1 AND id = $2", [orgId, id]);
  return r ? toCustomer(r) : null;
}

/**
 * Create the customer, or fill in what we learned. A field the business already has is never
 * overwritten by a caller's or a lead form's version (the CRM's name wins), except an empty one.
 */
export async function upsertCustomer(
  orgId: string,
  input: { phone: string; name?: string; email?: string; address?: Record<string, any>; externalId?: string | null; connector?: string | null; consentAt?: Date | null; consentSource?: string | null; notes?: string },
  run: Q = q
): Promise<Customer> {
  const rows = await run(
    `INSERT INTO customers (org_id, phone_e164, name, email, address, external_id, connector, consent_at, consent_source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, phone_e164) DO UPDATE SET
       name = CASE WHEN customers.name = '' THEN EXCLUDED.name ELSE customers.name END,
       email = CASE WHEN customers.email = '' THEN EXCLUDED.email ELSE customers.email END,
       address = CASE WHEN customers.address = '{}'::jsonb THEN EXCLUDED.address ELSE customers.address END,
       external_id = COALESCE(customers.external_id, EXCLUDED.external_id),
       connector = COALESCE(customers.connector, EXCLUDED.connector),
       consent_at = COALESCE(customers.consent_at, EXCLUDED.consent_at),
       consent_source = COALESCE(customers.consent_source, EXCLUDED.consent_source),
       notes = CASE WHEN customers.notes = '' THEN EXCLUDED.notes ELSE customers.notes END,
       updated_at = now()
     RETURNING *`,
    [orgId, input.phone, (input.name || "").trim().slice(0, 120), (input.email || "").trim().slice(0, 200), JSON.stringify(input.address || {}),
      input.externalId || null, input.connector || null, input.consentAt || null, input.consentSource || null, (input.notes || "").slice(0, 4000)]
  );
  return toCustomer(rows[0]);
}

export const customerPatchFields = ["name", "phone", "email", "notes", "address", "status", "stage", "tags"] as const;
export type CustomerPatch = Partial<{ name: string; phone: string; email: string; notes: string; address: Record<string, any>; status: string; stage: "lead" | "customer"; tags: string[] }>;

/** Staff edits are authoritative: they replace what is there. A status set by a person is locked. */
export async function updateCustomer(orgId: string, id: string, patch: CustomerPatch): Promise<Customer | null> {
  const cur = await getCustomer(orgId, id);
  if (!cur) return null;
  const rows = await q(
    `UPDATE customers SET name = $3, email = $4, notes = $5, address = $6, phone_e164 = $7, status = $8, stage = $9, tags = $10,
       status_locked = status_locked OR $11, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *`,
    [orgId, id, patch.name ?? cur.name, patch.email ?? cur.email, patch.notes ?? cur.notes, JSON.stringify(patch.address ?? cur.address),
      patch.phone ?? cur.phone, patch.status ?? cur.status, patch.stage ?? cur.stage, patch.tags ?? cur.tags, patch.status !== undefined && patch.status !== cur.status]
  );
  return toCustomer(rows[0]);
}

/** Call analysis writes the outcome onto the contact (like the CRM), unless a person set the status. */
export async function setStatusFromCall(customerId: string, outcome: string, run: Q = q): Promise<void> {
  if (!outcome || outcome === "unknown") return;
  await run("UPDATE customers SET status = $2, updated_at = now() WHERE id = $1 AND NOT status_locked", [customerId, outcome]);
}

const MAX_CONTEXT = 3500;

/**
 * What the agent should know about this caller, as compact plain text. Bounded: the newest and
 * most useful facts come first, and the whole thing stays under MAX_CONTEXT characters so it never
 * crowds the agent's own instructions.
 */
export async function buildCustomerMemory(org: Org, customer: Customer | null, now: Date = new Date()): Promise<{ profile: string; context: string }> {
  const tz = org.timezone;
  const lines: string[] = [`Today is ${speakTime(now, tz)} (${tz}).`];
  if (!customer) {
    lines.push("This caller is not in the system yet — a new customer. Ask for their name once.");
    return { profile: "", context: lines.join("\n") };
  }
  const a = customer.address || {};
  const profile = [
    customer.name ? `Name on file: ${customer.name}` : "Name: not on file yet",
    `Phone: ${customer.phone}`,
    customer.email ? `Email: ${customer.email}` : "",
    [a.street, a.city, a.state, a.postalCode].filter(Boolean).length ? `Address: ${[a.street, a.city, a.state, a.postalCode].filter(Boolean).join(", ")}` : "",
    customer.crmSnapshot?.membership ? `Membership: ${customer.crmSnapshot.membership.name} (${customer.crmSnapshot.membership.status})` : "",
    customer.notes ? `Notes from the office: ${customer.notes.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");

  const upcoming = await q(
    "SELECT job_type, starts_at FROM bookings WHERE org_id = $1 AND customer_id = $2 AND status IN ('booked','rescheduled') AND starts_at > now() ORDER BY starts_at LIMIT 3",
    [org.id, customer.id]
  );
  for (const b of upcoming) lines.push(`Upcoming job: ${b.job_type || "service visit"} on ${speakTime(new Date(b.starts_at), tz)}.`);

  const estimates = Array.isArray(customer.crmSnapshot?.estimates) ? customer.crmSnapshot.estimates.slice(0, 3) : [];
  for (const e of estimates) lines.push(`Open estimate: ${e.title} — $${(Number(e.amountCents || 0) / 100).toFixed(0)}.`);

  const calls = await q(
    `SELECT direction, started_at, outcome, summary FROM calls
     WHERE org_id = $1 AND customer_id = $2 AND summary <> '' ORDER BY started_at DESC LIMIT 5`,
    [org.id, customer.id]
  );
  if (calls.length) {
    lines.push("Earlier calls (newest first):");
    for (const c of calls) lines.push(`- ${speakTime(new Date(c.started_at), tz)} (${c.direction}${c.outcome ? ", " + c.outcome : ""}): ${String(c.summary).slice(0, 300)}`);
  }
  const lead = await one("SELECT source, service, message, received_at FROM leads WHERE org_id = $1 AND customer_id = $2 ORDER BY received_at DESC LIMIT 1", [org.id, customer.id]);
  if (lead) lines.push(`Latest enquiry: via ${lead.source}${lead.service ? ` for ${lead.service}` : ""}${lead.message ? ` — "${String(lead.message).slice(0, 200)}"` : ""}.`);

  let context = lines.join("\n");
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT - 1) + "…";
  return { profile, context };
}

/** The call variables every agent prompt renders. */
export async function memoryVariables(org: Org, customer: Customer | null): Promise<Record<string, string>> {
  const { profile, context } = await buildCustomerMemory(org, customer);
  return {
    // What the opening line says: "Hi {{greeting_name}}, …" — first name on file, else "there".
    greeting_name: (customer?.name || "").trim().split(/\s+/)[0] || "there",
    customer_name: customer?.name || "",
    business_name: org.name,
    profile,
    context,
  };
}
