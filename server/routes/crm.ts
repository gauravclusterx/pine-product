/**
 * Contacts (leads and customers) and their conversation — the ClusterOS CRM's customer section.
 *
 *   GET    /customers?stage=lead|customer|all&status=&q=   list with calls, last contact, tags
 *   POST   /customers                                      add a contact by hand
 *   GET    /customers/:id                                  contact + bookings + leads + DNC
 *   PATCH  /customers/:id                                  edit (a status set by a person is locked)
 *   DELETE /customers/:id
 *   GET    /customers/:id/conversation                     voice calls + SMS, newest first
 *   POST   /customers/:id/sms                              send an SMS from the app (1 message credit)
 *
 *   GET    /leads, POST /leads                             lead inbox (every source)
 *   PATCH  /leads/:id, DELETE /leads/:id                   edit / remove a lead
 */
import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { h, P, paging, parse, uuid } from "../http.js";
import { audit, requireRole } from "../auth/auth.js";
import { toE164 } from "../lib/phone.js";
import { getCustomer, updateCustomer, upsertCustomer } from "../modules/customers.js";
import { conversationFor } from "../modules/messages.js";
import { sendSms } from "../hub/notify.js";
import { getOrg } from "../modules/orgs.js";
import { acceptLead, leadInputSchema, listLeads } from "../intake/leads.js";

export const crmRouter = Router();
const viewer = requireRole("viewer");
const manager = requireRole("manager");

export const CONTACT_STATUSES = [
  "fresh", "contacted", "interested", "follow_up", "callback", "quote", "booked", "info",
  "not_interested", "no_contact", "transferred", "opt_out", "lost", "won",
] as const;

const tagList = z.array(z.string().trim().min(1).max(40)).max(30);

crmRouter.get("/customers", viewer, h(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const s = String(req.query.q || "").trim();
  const like = `%${s.replace(/[%_\\]/g, "\\$&")}%`;
  const stage = ["lead", "customer"].includes(String(req.query.stage)) ? String(req.query.stage) : "";
  const status = String(req.query.status || "");
  const rows = await q(
    `SELECT c.id, c.name, c.phone_e164, c.email, c.address, c.connector, c.stage, c.status, c.status_locked, c.tags, c.source, c.notes, c.created_at, c.updated_at,
       (SELECT max(started_at) FROM calls x WHERE x.org_id = c.org_id AND x.customer_id = c.id) AS last_call_at,
       (SELECT count(*)::int FROM calls x WHERE x.org_id = c.org_id AND x.customer_id = c.id) AS calls,
       (SELECT count(*)::int FROM messages m WHERE m.org_id = c.org_id AND m.customer_id = c.id) AS messages,
       (SELECT count(*)::int FROM bookings b WHERE b.org_id = c.org_id AND b.customer_id = c.id AND b.status <> 'cancelled') AS bookings
     FROM customers c
     WHERE c.org_id = $1 AND ($2 = '' OR c.stage = $2) AND ($3 = '' OR c.status = $3)
       AND ($4 = '' OR c.name ILIKE $5 OR c.phone_e164 LIKE $5 OR c.email ILIKE $5 OR $4 = ANY(c.tags))
     ORDER BY c.updated_at DESC LIMIT $6 OFFSET $7`,
    [req.auth!.orgId, stage, status, s, like, limit, offset]
  );
  const [counts] = await q(
    "SELECT count(*) FILTER (WHERE stage = 'lead')::int AS leads, count(*) FILTER (WHERE stage = 'customer')::int AS customers FROM customers WHERE org_id = $1",
    [req.auth!.orgId]
  );
  res.json({ customers: rows, counts, statuses: CONTACT_STATUSES });
}));

crmRouter.post("/customers", manager, h(async (req, res) => {
  const org = await getOrg(req.auth!.orgId);
  const b = parse(z.object({
    name: z.string().trim().max(120).default(""), phone: z.string().trim().min(5).max(30), email: z.string().trim().max(200).default(""),
    stage: z.enum(["lead", "customer"]).default("customer"), status: z.string().max(40).default("fresh"), notes: z.string().max(4000).default(""), tags: tagList.default([]),
  }), req.body);
  const phone = toE164(b.phone, org.settings.defaultCountryCode);
  if (!phone) throw badRequest("That phone number does not look right.");
  if (await one("SELECT 1 AS x FROM customers WHERE org_id = $1 AND phone_e164 = $2", [org.id, phone])) throw badRequest("A contact with this phone number already exists.");
  const c = await upsertCustomer(org.id, { phone, name: b.name, email: b.email, notes: b.notes });
  const saved = await updateCustomer(org.id, c.id, { stage: b.stage, status: b.status, tags: b.tags });
  await q("UPDATE customers SET source = 'manual' WHERE id = $1", [c.id]);
  await audit(org.id, req.auth!.userId, "customer.created", { customerId: c.id });
  res.status(201).json({ customer: saved });
}));

crmRouter.get("/customers/:id", viewer, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const c = await getCustomer(req.auth!.orgId, id);
  if (!c) throw notFound("Customer not found.");
  const [calls, bookings, leads] = await Promise.all([
    q("SELECT id, direction, started_at, duration_seconds, outcome, summary, qa_score FROM calls WHERE org_id = $1 AND customer_id = $2 ORDER BY started_at DESC LIMIT 50", [req.auth!.orgId, id]),
    q("SELECT id, job_type, starts_at, ends_at, status, connector, value_cents FROM bookings WHERE org_id = $1 AND customer_id = $2 ORDER BY starts_at DESC LIMIT 50", [req.auth!.orgId, id]),
    q("SELECT id, source, service, status, received_at FROM leads WHERE org_id = $1 AND customer_id = $2 ORDER BY received_at DESC LIMIT 50", [req.auth!.orgId, id]),
  ]);
  const dnc = !!(await one("SELECT 1 AS x FROM dnc_list WHERE org_id = $1 AND phone_e164 = $2", [req.auth!.orgId, c.phone]));
  res.json({ customer: c, calls, bookings, leads, dnc });
}));

crmRouter.patch("/customers/:id", manager, h(async (req, res) => {
  const org = await getOrg(req.auth!.orgId);
  const patch = parse(z.object({
    name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().max(200).optional(), notes: z.string().max(4000).optional(),
    address: z.record(z.string(), z.string().max(200)).optional(), status: z.string().trim().min(1).max(40).optional(),
    stage: z.enum(["lead", "customer"]).optional(), tags: tagList.optional(),
  }), req.body);
  if (patch.phone !== undefined) {
    const e164 = toE164(patch.phone, org.settings.defaultCountryCode);
    if (!e164) throw badRequest("That phone number does not look right.");
    const other = await one("SELECT id FROM customers WHERE org_id = $1 AND phone_e164 = $2", [org.id, e164]);
    if (other && other.id !== P(req).id) throw badRequest("Another contact already has this phone number.");
    patch.phone = e164;
  }
  const c = await updateCustomer(org.id, parse(uuid, P(req).id), patch);
  if (!c) throw notFound("Customer not found.");
  await audit(org.id, req.auth!.userId, "customer.updated", { customerId: c.id, fields: Object.keys(patch) });
  res.json({ customer: c });
}));

crmRouter.delete("/customers/:id", manager, h(async (req, res) => {
  const r = await one("DELETE FROM customers WHERE org_id = $1 AND id = $2 RETURNING id", [req.auth!.orgId, parse(uuid, P(req).id)]);
  if (!r) throw notFound("Customer not found.");
  await audit(req.auth!.orgId, req.auth!.userId, "customer.deleted", { customerId: r.id });
  res.json({ ok: true });
}));

crmRouter.get("/customers/:id/conversation", viewer, h(async (req, res) => {
  const c = await conversationFor(req.auth!.orgId, parse(uuid, P(req).id));
  if (!c) throw notFound("Customer not found.");
  res.json(c);
}));

crmRouter.post("/customers/:id/sms", manager, h(async (req, res) => {
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(600) }), req.body);
  const c = await getCustomer(req.auth!.orgId, parse(uuid, P(req).id));
  if (!c) throw notFound("Customer not found.");
  const r = await sendSms(req.auth!.orgId, c.phone, body, undefined, { author: "human" });
  if (!r.sent) throw badRequest(`Not sent: ${r.detail}`);
  res.json({ ok: true });
}));

// ── leads ─────────────────────────────────────────────────────────────────────

crmRouter.get("/leads", viewer, h(async (req, res) => {
  const { limit, offset } = paging(req.query);
  res.json({ leads: await listLeads(req.auth!.orgId, { status: req.query.status ? String(req.query.status) : undefined, source: req.query.source ? String(req.query.source) : undefined }, limit, offset) });
}));

crmRouter.post("/leads", manager, h(async (req, res) => {
  const org = await getOrg(req.auth!.orgId);
  const input = parse(leadInputSchema.omit({ source: true, sourceRef: true }), req.body);
  res.status(201).json(await acceptLead(org, { ...input, source: "manual", sourceRef: `manual:${req.auth!.userId}:${Date.now()}` }));
}));

crmRouter.patch("/leads/:id", manager, h(async (req, res) => {
  const org = await getOrg(req.auth!.orgId);
  const b = parse(z.object({
    name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().max(200).optional(),
    service: z.string().max(200).optional(), postalCode: z.string().max(20).optional(), message: z.string().max(4000).optional(),
    status: z.enum(["new", "queued", "calling", "contacted", "booked", "lost", "rejected"]).optional(),
  }), req.body);
  const cur = await one("SELECT * FROM leads WHERE org_id = $1 AND id = $2", [org.id, parse(uuid, P(req).id)]);
  if (!cur) throw notFound("Lead not found.");
  let phone = cur.phone_e164;
  if (b.phone !== undefined) {
    phone = toE164(b.phone, org.settings.defaultCountryCode);
    if (!phone) throw badRequest("That phone number does not look right.");
  }
  const row = await one(
    `UPDATE leads SET name = $3, phone_e164 = $4, email = $5, service = $6, postal_code = $7, message = $8, status = $9, updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING *`,
    [org.id, cur.id, b.name ?? cur.name, phone, b.email ?? cur.email, b.service ?? cur.service, b.postalCode ?? cur.postal_code, b.message ?? cur.message, b.status ?? cur.status]
  );
  // Keep the contact in step with what the person typed.
  if (row!.customer_id && (b.name !== undefined || b.email !== undefined)) {
    await q("UPDATE customers SET name = CASE WHEN $2 = '' THEN name ELSE $2 END, email = CASE WHEN $3 = '' THEN email ELSE $3 END, updated_at = now() WHERE id = $1", [row!.customer_id, b.name ?? "", b.email ?? ""]);
  }
  await audit(org.id, req.auth!.userId, "lead.updated", { leadId: cur.id, fields: Object.keys(b) });
  res.json({ lead: row });
}));

crmRouter.delete("/leads/:id", manager, h(async (req, res) => {
  const r = await one("DELETE FROM leads WHERE org_id = $1 AND id = $2 RETURNING id", [req.auth!.orgId, parse(uuid, P(req).id)]);
  if (!r) throw notFound("Lead not found.");
  await audit(req.auth!.orgId, req.auth!.userId, "lead.deleted", { leadId: r.id });
  res.json({ ok: true });
}));
