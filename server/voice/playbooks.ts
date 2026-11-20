/**
 * Internal playbooks. Every agent is custom-made for its client, but it is started from one of
 * these: the playbook supplies the call's job and flow, the client's settings supply the facts
 * (name, hours, services, prices, area), and staff edit the result before publishing.
 */
import type { Org } from "../modules/orgs.js";
import { businessHoursOf } from "../modules/orgs.js";

export const PLAYBOOKS = {
  inbound_booking: { label: "Inbound booking", direction: "inbound", summary: "Answers every call, books the job, transfers emergencies." },
  speed_to_lead: { label: "Speed to lead", direction: "outbound", summary: "Calls a new lead within a minute and books the visit." },
  estimate_followup: { label: "Estimate follow-up", direction: "outbound", summary: "Follows up open estimates and books the job." },
  membership_renewal: { label: "Membership renewal", direction: "outbound", summary: "Renews expiring maintenance plans and books the tune-up." },
  reactivation: { label: "Reactivation", direction: "outbound", summary: "Calls past customers who are due for service." },
  after_job: { label: "After-job call", direction: "outbound", summary: "Checks the customer is happy and asks for a review." },
  reminder: { label: "Appointment reminder", direction: "outbound", summary: "Confirms tomorrow's appointment, reschedules if needed." },
  custom: { label: "Custom", direction: "inbound", summary: "Start from a blank brief." },
} as const;
export type Playbook = keyof typeof PLAYBOOKS;

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hm = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12;
  return `${h12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${ap}`;
};

/** The facts every agent of this client must get right. */
export function businessFacts(org: Org): string {
  const s = org.settings;
  const hours = businessHoursOf(org).map((d, i) => `${DAY[i]}: ${d ? `${hm(d.open)}–${hm(d.close)}` : "closed"}`).join("; ");
  const services = s.services.length
    ? s.services.map((x) => `${x.name}${x.valueCents ? ` (typical ticket $${Math.round(x.valueCents / 100)})` : ""}`).join(", ")
    : "general service visits";
  return [
    `Business: ${org.name} (${org.industry.replace(/_/g, " ")}), time zone ${org.timezone}.`,
    `Opening hours: ${hours}.`,
    `Services: ${services}.`,
    s.serviceAreas.length ? `Service area (postal codes): ${s.serviceAreas.slice(0, 60).join(", ")}${s.serviceAreas.length > 60 ? " and more" : ""}. Check the caller's postal code with the availability tool.` : "",
    "Never quote a final price: say a technician confirms the price on site. You may mention a typical range only if it is listed above.",
  ].filter(Boolean).join("\n");
}

const FLOWS: Record<Playbook, string> = {
  inbound_booking:
    "You answer the phone for the business. Find out what the caller needs, whether it is urgent, and their service address and postal code. " +
    "Check open windows with get_availability, offer two or three, and book the one they pick with book_job. " +
    "If they do not want to book now, save them with create_lead. " +
    "Emergencies (gas smell, flooding, sparks, no heat in freezing weather, anyone unsafe): tell them to get safe, then transfer to a person; if transfer is not possible, use notify_team with kind emergency.",
  speed_to_lead:
    "You are calling someone who just asked the business for help (the context says what they asked for). Introduce yourself and the business, mention their request, " +
    "confirm what they need and their address, then offer windows from get_availability and book with book_job. If now is a bad time, ask when to call back and save it with create_lead.",
  estimate_followup:
    "You are following up an estimate the business gave this customer (see the context, or call get_estimates). Ask if they have questions, " +
    "and if they are ready, book the job with get_availability and book_job. If they decline, ask (once, politely) why, and save it with create_lead.",
  membership_renewal:
    "The customer's maintenance plan is ending (call get_membership). Explain briefly what the plan includes, offer to renew, and book their seasonal tune-up with get_availability and book_job. " +
    "Never take card details on the call: say the office will send a secure payment link.",
  reactivation:
    "You are calling a past customer who is due for service. Remind them when they last had service if the context says so, offer a visit, and book it. Keep it short and friendly; accept a no gracefully.",
  after_job:
    "You are calling after a completed job to check the customer is happy. If they are, ask if they would leave a review and send the review link with send_sms. " +
    "If anything is wrong, apologise, collect the details and use notify_team with kind unhappy_customer.",
  reminder:
    "You are confirming the customer's appointment (see the context). If it still works, thank them. If not, offer new windows and move it with reschedule_job, or cancel with cancel_job.",
  custom: "Follow the brief below.",
};

const ALWAYS =
  "RULES\n" +
  "● Keep answers short — one or two sentences — and ask one question at a time.\n" +
  "● Never invent availability, prices, policies or technician names. Only offer windows a tool returned.\n" +
  "● When you check or book, pass what the customer said; the tools do the date and time work. If a tool says a time could not be read, ask only for the missing part.\n" +
  "● If the caller asks not to be called again, apologise, confirm, and end the call — they are removed automatically.\n" +
  "● If you are unsure or the caller asks for a person, offer to transfer or to have the office call back.";

export function composePrompt(org: Org, playbook: Playbook, brief: string, agentName: string): string {
  return [
    `You are ${agentName}, the AI phone assistant of ${org.name}.`,
    "",
    "YOUR JOB",
    FLOWS[playbook] || FLOWS.custom,
    brief.trim() ? `\nCLIENT BRIEF (from ${org.name})\n${brief.trim()}` : "",
    "",
    "BUSINESS FACTS",
    businessFacts(org),
    "",
    ALWAYS,
  ].filter((l) => l !== undefined).join("\n");
}

export function defaultGreeting(org: Org, playbook: Playbook, agentName: string): string {
  if (PLAYBOOKS[playbook]?.direction === "outbound") return `Hi, this is ${agentName} calling from ${org.name}. Is now a good moment?`;
  return `Thanks for calling ${org.name}, this is ${agentName}. How can I help you today?`;
}

/** Post-call fields every agent extracts; they drive outcomes, the dashboard and QA. */
export const EXTRACTION_FIELDS = [
  { name: "outcome", type: "selector", description: "How the call ended for the business.", choices: ["booked", "callback", "quote", "info", "not_interested", "no_contact", "transferred", "opt_out", "unknown"], required: true },
  { name: "service_requested", type: "text", description: "The service the customer asked about, in a few words." },
  { name: "urgency", type: "selector", description: "How urgent the customer's need is.", choices: ["emergency", "soon", "flexible", "unknown"] },
  { name: "sentiment", type: "selector", description: "The customer's mood at the end of the call.", choices: ["positive", "neutral", "negative"] },
  { name: "callback_time", type: "text", description: "When the customer asked to be called back, as they said it. Empty if not asked." },
  { name: "opted_out", type: "boolean", description: "True if the customer asked not to be called again." },
];
