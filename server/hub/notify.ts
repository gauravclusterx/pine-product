/**
 * Outbound messages: SMS to the customer (Twilio) and alerts to the team (Slack, email).
 * Every send is recorded in the audit log; a channel that is not connected is reported, not
 * pretended.
 */
import { q } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { getIntegration } from "./registry.js";
import { fetchHttp } from "./http.js";
import type { HttpFn } from "./types.js";

export interface SendResult { sent: boolean; channel: string; detail: string }

async function isDnc(orgId: string, phone: string): Promise<boolean> {
  return (await q("SELECT 1 FROM dnc_list WHERE org_id = $1 AND phone_e164 = $2", [orgId, phone])).length > 0;
}

export async function sendSms(orgId: string, to: string, body: string, http: HttpFn = fetchHttp): Promise<SendResult> {
  if (await isDnc(orgId, to)) return { sent: false, channel: "sms", detail: "the number has opted out" };
  const tw = await getIntegration(orgId, "twilio");
  if (!tw || tw.status === "disabled") return { sent: false, channel: "sms", detail: "SMS is not connected" };
  const { accountSid, authToken } = tw.credentials;
  const params = new URLSearchParams({ To: to, Body: body.slice(0, 1500), MessagingServiceSid: String(tw.settings.messagingServiceSid || "") });
  const res = await http({
    method: "POST",
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    headers: { authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const ok = res.status >= 200 && res.status < 300;
  // Twilio error 21610: the recipient replied STOP. Honour it everywhere, not only for SMS.
  if (res.data?.code === 21610) {
    await q("INSERT INTO dnc_list (org_id, phone_e164, reason, source) VALUES ($1, $2, 'opt_out', 'sms_stop') ON CONFLICT DO NOTHING", [orgId, to]);
  }
  await q("INSERT INTO audit_log (org_id, action, detail) VALUES ($1, 'sms.send', $2)", [orgId, JSON.stringify({ to: to.slice(-4), ok, status: res.status })]);
  if (!ok) log.warn({ orgId, status: res.status, code: res.data?.code }, "sms failed");
  return { sent: ok, channel: "sms", detail: ok ? "sent" : `Twilio ${res.status}: ${res.data?.message || "error"}` };
}

export type AlertKind = "new_booking" | "emergency" | "lost_lead" | "unhappy_customer" | "transfer_failed" | "new_lead" | "info";

const EMOJI: Record<AlertKind, string> = { new_booking: "✅", emergency: "🚨", lost_lead: "⚠️", unhappy_customer: "😠", transfer_failed: "📞", new_lead: "🆕", info: "ℹ️" };

/** Post to every connected team channel. Returns what happened per channel. */
export async function notifyTeam(orgId: string, kind: AlertKind, text: string, http: HttpFn = fetchHttp): Promise<SendResult[]> {
  const out: SendResult[] = [];
  const message = `${EMOJI[kind] || ""} ${text}`.trim().slice(0, 3000);
  const slack = await getIntegration(orgId, "slack");
  if (slack && slack.status !== "disabled") {
    let res;
    if (slack.credentials.webhookUrl) {
      res = await http({ method: "POST", url: slack.credentials.webhookUrl, body: { text: message } });
    } else {
      res = await http({ method: "POST", url: "https://slack.com/api/chat.postMessage", headers: { authorization: `Bearer ${slack.credentials.botToken}` }, body: { channel: slack.settings.channel, text: message } });
    }
    // chat.postMessage answers 200 with ok:false on errors.
    const ok = res.status >= 200 && res.status < 300 && res.data?.ok !== false;
    out.push({ sent: ok, channel: "slack", detail: ok ? "sent" : `Slack: ${res.data?.error || res.status}` });
  }
  const mail = await getIntegration(orgId, "email_alerts");
  if (mail && mail.status !== "disabled") {
    const res = await http({
      method: "POST", url: "https://api.resend.com/emails", headers: { authorization: `Bearer ${mail.credentials.apiKey}` },
      body: { from: mail.settings.from, to: String(mail.settings.to).split(",").map((s) => s.trim()).filter(Boolean), subject: `[Pine AI] ${kind.replace(/_/g, " ")}`, text: message },
    });
    const ok = res.status >= 200 && res.status < 300;
    out.push({ sent: ok, channel: "email", detail: ok ? "sent" : `Email ${res.status}` });
  }
  // Always kept in the dashboard feed, connected channels or not.
  await q("INSERT INTO audit_log (org_id, action, detail) VALUES ($1, 'team.alert', $2)", [orgId, JSON.stringify({ kind, text: message.slice(0, 500), channels: out })]);
  return out;
}
