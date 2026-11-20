/**
 * Source adapters: turn what each lead platform sends into a LeadInput.
 *
 * Push sources (Angi, Thumbtack, website forms) post the lead itself. Meta and Yelp post only an
 * id, and the lead is fetched with the client's token. Google LSA sends nothing: it is polled.
 * Every platform's documented shape is replayed in tests; until partner access is granted the
 * email fallback (`parseLeadEmail`) lets a client go live.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { HttpFn } from "../hub/types.js";
import { expectOk } from "../hub/types.js";
import type { LeadInput } from "./leads.js";

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");

/** Website form / generic API: our own documented JSON. */
export function fromWebForm(body: any): LeadInput {
  const ref = str(body.id || body.submissionId || body.reference) || `${str(body.phone)}:${new Date().toISOString().slice(0, 16)}`;
  return {
    source: body.source === "web_chat" ? "web_chat" : "web_form", sourceRef: ref,
    name: str(body.name || [body.firstName, body.lastName].filter(Boolean).join(" "), 120), phone: str(body.phone, 40), email: str(body.email),
    service: str(body.service, 120), postalCode: str(body.postalCode || body.zip, 12), street: str(body.street || body.address), city: str(body.city, 100), state: str(body.state, 50),
    message: str(body.message, 4000), consent: body.consent === true || body.consent === "true" || body.consent === "on", payload: {},
  };
}

/** Angi: JSON POST per lead (field names per Angi's lead delivery spec). */
export function fromAngi(body: any): LeadInput {
  const loc = body.location || body.address || {};
  return {
    source: "angi", sourceRef: str(body.leadOid || body.leadId || body.srOid || body.id) || "",
    name: str(body.name || [body.firstName, body.lastName].filter(Boolean).join(" "), 120), phone: str(body.primaryPhone || body.phone, 40), email: str(body.email),
    service: str(body.taskName || body.category || body.service, 120), postalCode: str(body.postalCode || loc.postalCode || loc.zip, 12),
    street: str(loc.address1 || loc.street), city: str(loc.city, 100), state: str(loc.state || loc.stateProvince, 50),
    message: str(body.comments || body.description, 4000),
    // Angi homeowners agree to be contacted by the matched pros.
    consent: true, payload: { leadType: body.leadType || null },
  };
}

/** Thumbtack: the partner API calls our endpoint with a lead (negotiation) object. */
export function fromThumbtack(body: any): LeadInput {
  const lead = body.lead || body.data || body;
  const c = lead.customer || {};
  const req = lead.request || {};
  return {
    source: "thumbtack", sourceRef: str(lead.leadID || lead.negotiationID || lead.id) || "",
    name: str(c.name || [c.firstName, c.lastName].filter(Boolean).join(" "), 120), phone: str(c.phone || c.phoneNumber, 40), email: "",
    service: str(req.category || req.title, 120), postalCode: str(req.location?.zipCode || req.zipCode, 12), city: str(req.location?.city, 100), state: str(req.location?.state, 50),
    message: str(req.description, 4000), consent: !!(c.phone || c.phoneNumber), payload: {},
  };
}

/** Meta leadgen webhook: verify the signature, list the lead ids. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(header.slice(7), "hex"); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

export function metaLeadIds(body: any): Array<{ leadgenId: string; pageId: string; formId: string }> {
  const out: Array<{ leadgenId: string; pageId: string; formId: string }> = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry?.changes || []) {
      if (ch?.field === "leadgen" && ch?.value?.leadgen_id) out.push({ leadgenId: String(ch.value.leadgen_id), pageId: String(ch.value.page_id || entry.id || ""), formId: String(ch.value.form_id || "") });
    }
  }
  return out;
}

/** Fetch one Meta lead and map its form answers. */
export async function fetchMetaLead(http: HttpFn, leadgenId: string, pageToken: string): Promise<LeadInput> {
  const res = await http({ method: "GET", url: `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}`, query: { access_token: pageToken, fields: "created_time,field_data,form_id,custom_disclaimer_responses" } });
  const d = expectOk(res, "Meta lead fetch");
  const f: Record<string, string> = {};
  for (const x of d.field_data || []) f[String(x.name).toLowerCase()] = String((x.values || [])[0] ?? "");
  const consent = (d.custom_disclaimer_responses || []).some((r: any) => r.is_checked === "1" || r.is_checked === true);
  return {
    source: "meta", sourceRef: leadgenId,
    name: f.full_name || [f.first_name, f.last_name].filter(Boolean).join(" "), phone: f.phone_number || f.phone || "", email: f.email || "",
    service: f.service || f["what_service_do_you_need?"] || "", postalCode: f.zip_code || f.post_code || f.zip || "", street: f.street_address || "", city: f.city || "", state: f.state || "",
    message: f.message || f.comments || "",
    // Meta lead ads disclose that the advertiser will contact the person; a custom consent box, if any, must be ticked.
    consent: (d.custom_disclaimer_responses || []).length ? consent : true,
    receivedAt: d.created_time ? new Date(d.created_time) : undefined, payload: { formId: d.form_id || "" },
  };
}

/** Yelp Leads: the webhook names the lead; the lead and its events are fetched. */
export async function fetchYelpLead(http: HttpFn, leadId: string, accessToken: string): Promise<LeadInput> {
  const res = await http({ method: "GET", url: `https://api.yelp.com/v3/leads/${encodeURIComponent(leadId)}`, headers: { authorization: `Bearer ${accessToken}` } });
  const d = expectOk(res, "Yelp lead fetch");
  const job = d.project || {};
  return {
    source: "yelp", sourceRef: leadId, name: str(d.user?.display_name, 120),
    // Yelp shares the consumer's phone only when they typed it in the conversation.
    phone: str(d.phone_number || d.user?.phone_number, 40), email: "",
    service: str(job.job_names?.[0] || job.service, 120), postalCode: str(job.location?.postal_code, 12),
    message: str(job.survey_answers?.map?.((a: any) => `${a.question_text}: ${(a.answer_text || []).join(", ")}`).join("\n"), 4000),
    consent: !!(d.phone_number || d.user?.phone_number), payload: {},
  };
}

/** Google LSA: GAQL query for leads since a time. Rows → LeadInput. */
export const LSA_QUERY = (sinceIso: string) =>
  `SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.category_id, local_services_lead.service_id, ` +
  `local_services_lead.contact_details, local_services_lead.lead_status, local_services_lead.creation_date_time ` +
  `FROM local_services_lead WHERE local_services_lead.creation_date_time > '${sinceIso.replace(/'/g, "").replace("T", " ").slice(0, 19)}' ORDER BY local_services_lead.creation_date_time`;

export function fromLsaRow(row: any): LeadInput {
  const l = row.localServicesLead || row.local_services_lead || {};
  const c = l.contactDetails || l.contact_details || {};
  return {
    source: "google_lsa", sourceRef: String(l.id || ""), name: str(c.consumerName || c.consumer_name, 120), phone: str(c.phoneNumber || c.phone_number, 40), email: str(c.email),
    service: str(l.serviceId || l.service_id || l.categoryId || l.category_id, 120).replace(/^.*:/, "").replace(/_/g, " "),
    postalCode: "", message: `Google LSA ${String(l.leadType || l.lead_type || "").toLowerCase().replace(/_/g, " ")} lead`,
    // A consumer who contacts the business through LSA asked to be contacted.
    consent: true, receivedAt: l.creationDateTime || l.creation_date_time ? new Date(String(l.creationDateTime || l.creation_date_time).replace(" ", "T")) : undefined,
    payload: { leadType: l.leadType || l.lead_type || null },
  };
}

/**
 * Fallback for every source: the platform's lead-notification email, forwarded to the client's
 * inbound address. Pulls the fields platforms put in plain text ("Name: …", "Phone: …").
 */
export function parseLeadEmail(input: { from: string; subject: string; text: string; messageId: string }): LeadInput | null {
  const text = `${input.subject}\n${input.text}`.replace(/\r/g, "");
  const field = (...labels: string[]) => {
    for (const l of labels) {
      const m = new RegExp(`^\\s*(?:${l})\\s*[:\\-]\\s*(.+)$`, "im").exec(text);
      if (m) return m[1].trim();
    }
    return "";
  };
  const phone = field("phone(?: number)?", "mobile", "tel", "contact number") || (/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.exec(text)?.[1] ?? "");
  if (!phone) return null;
  const from = input.from.toLowerCase();
  const source: LeadInput["source"] = /angi|homeadvisor/.test(from) ? "angi" : /thumbtack/.test(from) ? "thumbtack" : /yelp/.test(from) ? "yelp" : /google/.test(from) ? "google_lsa" : /facebook|meta/.test(from) ? "meta" : "email";
  return {
    source, sourceRef: `email:${input.messageId}`,
    name: field("name", "customer(?: name)?", "full name", "homeowner"), phone, email: field("e-?mail"),
    service: field("service(?: requested)?", "job type", "task", "category", "project"), postalCode: field("zip(?: code)?", "postal code", "post code"),
    street: field("address", "street"), city: field("city"), state: field("state"),
    message: field("message", "comments?", "details", "description") || input.subject,
    consent: source !== "email", payload: { via: "email" },
  };
}
