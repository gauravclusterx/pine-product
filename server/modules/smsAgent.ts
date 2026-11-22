/**
 * SMS agent — the text counterpart of the voice agent (the CRM's chat agent):
 * an inbound text is saved to the contact's conversation; STOP opts the number out; when the
 * business switched the SMS agent on, an AI reply is written with the admin-set AI key (OpenAI or Anthropic) from the
 * business profile, the contact's history and the recent thread, and sent as SMS — which takes
 * 1 message credit (refused at 0, refunded if the send fails).
 */
import { q } from "../db/pool.js";
import { log } from "../lib/logger.js";
import type { Org } from "./orgs.js";
import { recordMessage } from "./messages.js";
import { aiAvailable, chatFor, type ChatFn } from "./ai.js";
import { buildCustomerMemory, findCustomerByPhone, upsertCustomer } from "./customers.js";
import { sendSms } from "../hub/notify.js";
import type { HttpFn } from "../hub/types.js";
import { fetchHttp } from "../hub/http.js";
import { automationAllowed, hasCredit } from "./billing.js";

const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

export async function handleInboundSms(org: Org, from: string, body: string, deps: { chat?: ChatFn; http?: HttpFn } = {}): Promise<{ replied: boolean; reason?: string }> {
  await upsertCustomer(org.id, { phone: from });
  await recordMessage({ orgId: org.id, phone: from, direction: "in", author: "customer", body, status: "received" });
  if (STOP.test(body)) {
    await q("INSERT INTO dnc_list (org_id, phone_e164, reason, source) VALUES ($1, $2, 'opt_out', 'sms_stop') ON CONFLICT DO NOTHING", [org.id, from]);
    return { replied: false, reason: "opted out" };
  }
  if (!org.settings.smsAgent?.enabled) return { replied: false, reason: "SMS agent is off" };
  if (!(await automationAllowed(org.id))) return { replied: false, reason: "subscription not active" };
  if (!(await hasCredit(org.id, "chat", 1))) return { replied: false, reason: "no message credits" };
  if (!(await aiAvailable(org.id))) return { replied: false, reason: "no AI key" };

  const customer = await findCustomerByPhone(org.id, from);
  const thread = await q("SELECT direction, body FROM messages WHERE org_id = $1 AND phone_e164 = $2 ORDER BY created_at DESC LIMIT 12", [org.id, from]);
  const memory = await buildCustomerMemory(org, customer);
  const services = (org.settings.services || []).map((s) => s.name).join(", ");
  const system = [
    `You are the text-message assistant of ${org.name}, a home-service business (${org.industry.replace(/_/g, " ")}). Time zone: ${org.timezone}.`,
    services ? `Services: ${services}.` : "",
    customer?.name ? `You are texting ${customer.name}.` : "",
    memory.profile ? `What we know about this customer:\n${memory.profile}` : "",
    memory.context ? `History across calls and messages:\n${memory.context}` : "",
    org.settings.smsAgent.instructions ? `Owner's instructions: ${org.settings.smsAgent.instructions}` : "",
    "Reply in one or two short, friendly sentences, in the customer's language. Never invent prices, dates or promises. If they want to book or need a person, say the team will call them shortly.",
  ].filter(Boolean).join("\n");
  const history = thread.reverse().map((m) => ({ role: m.direction === "in" ? "user" as const : "assistant" as const, content: m.body }));
  let reply = "";
  try {
    reply = (await chatFor(org.id, { system, messages: history, maxTokens: 800 }, deps.chat)).text;
  } catch (err) {
    log.warn({ orgId: org.id, err: (err as Error).message }, "sms agent: AI reply failed");
    return { replied: false, reason: "AI reply failed" };
  }
  if (!reply) return { replied: false, reason: "empty reply" };
  const r = await sendSms(org.id, from, reply.slice(0, 600), deps.http || fetchHttp, { author: "agent" });
  return { replied: r.sent, reason: r.sent ? undefined : r.detail };
}
