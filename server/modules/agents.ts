/**
 * Agent builder. The agent as designed here (agents.config) is the source of truth; the voice
 * provider holds a projection of it. Saving edits the provider's DRAFT; publishing makes it live.
 *
 *   create  → row + provider agent (draft, not live)
 *   update  → row + provider draft
 *   publish → validate, attach the Integration Hub tools, publish, record the live version
 *   pause   → move inbound numbers off it and stop new calls (row status "paused")
 *   archive → provider archive (14-day undo at the provider), row status "archived"
 */
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { hasPublicBaseUrl, publicBaseUrl } from "../config.js";
import { toE164 } from "../lib/phone.js";
import * as rasen from "../voice/rasen/service.js";
import type { WebhookToolSpec } from "../voice/rasen/service.js";
import { composePrompt, defaultGreeting, EXTRACTION_FIELDS, PLAYBOOKS, type Playbook } from "../voice/playbooks.js";
import { getOrg, type Org } from "./orgs.js";
import { requireVoiceWorkspace, type VoiceWorkspace } from "./voiceWorkspace.js";

export const TOOL_SECRET_HEADER = "x-pine-tool-secret";

export const agentConfigSchema = z.object({
  greeting: z.string().trim().max(500).optional(),
  /** Client-specific instructions added to the playbook. */
  brief: z.string().max(12_000).default(""),
  /** Full prompt override. When set, it replaces the generated prompt (facts and rules included). */
  promptOverride: z.string().max(30_000).default(""),
  voiceId: z.string().max(120).nullable().default(null),
  language: z.enum(["en", "hi", "hinglish"]).default("en"),
  maxCallMinutes: z.number().int().min(1).max(60).default(10),
  voicemail: z.enum(["hang_up", "leave_message"]).default("leave_message"),
  voicemailMessage: z.string().max(500).default(""),
  /** Where the agent transfers a caller who needs a person ("" = the org's transfer number). */
  transferNumber: z.string().max(20).default(""),
  tools: z.array(z.string()).optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(60),
  playbook: z.enum(Object.keys(PLAYBOOKS) as [Playbook, ...Playbook[]]).default("inbound_booking"),
  config: agentConfigSchema.prefault({}),
});

export interface AgentRow {
  id: string; orgId: string; name: string; playbook: Playbook; status: string; config: AgentConfig;
  providerAgentId: string | null; liveVersionId: string | null; publishedAt: Date | null; publishError: string | null;
  createdAt: Date; updatedAt: Date;
}

function toAgent(r: any): AgentRow {
  const parsed = agentConfigSchema.safeParse(r.config || {});
  return {
    id: r.id, orgId: r.org_id, name: r.name, playbook: r.playbook, status: r.status, config: parsed.success ? parsed.data : agentConfigSchema.parse({}),
    providerAgentId: r.provider_agent_id, liveVersionId: r.live_version_id, publishedAt: r.published_at, publishError: r.publish_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listAgents(orgId: string): Promise<AgentRow[]> {
  return (await q("SELECT * FROM agents WHERE org_id = $1 AND status <> 'archived' ORDER BY created_at", [orgId])).map(toAgent);
}

export async function getAgent(orgId: string, id: string): Promise<AgentRow> {
  const r = await one("SELECT * FROM agents WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw notFound("Agent not found.");
  return toAgent(r);
}

export async function agentByProviderId(providerAgentId: string): Promise<AgentRow | null> {
  const r = await one("SELECT * FROM agents WHERE provider_agent_id = $1", [providerAgentId]);
  return r ? toAgent(r) : null;
}

/** Tools by playbook. The before-call lookup only exists on inbound agents (provider rule). */
export function toolsFor(playbook: Playbook): string[] {
  const common = ["get_availability", "book_job", "create_lead", "send_sms", "notify_team"];
  switch (playbook) {
    case "inbound_booking": return ["lookup_customer", ...common, "reschedule_job", "cancel_job", "get_estimates", "get_membership"];
    case "estimate_followup": return [...common, "get_estimates"];
    case "membership_renewal": return [...common, "get_membership"];
    case "reminder": return [...common, "reschedule_job", "cancel_job"];
    default: return common;
  }
}

/** Exactly what the provider gets for one agent. Pure, so it is unit-tested. */
export function providerConfig(org: Org, agent: { name: string; playbook: Playbook; config: AgentConfig }): rasen.AgentConfigInput {
  const c = agent.config;
  const outbound = PLAYBOOKS[agent.playbook]?.direction === "outbound";
  return {
    name: agent.name,
    systemPrompt: c.promptOverride.trim() || composePrompt(org, agent.playbook, c.brief, agent.name),
    firstMessage: c.greeting?.trim() || defaultGreeting(org, agent.playbook, agent.name),
    voiceId: c.voiceId,
    language: c.language,
    timezone: org.timezone,
    callDirection: outbound ? "outbound" : "inbound",
    maxCallDurationSeconds: c.maxCallMinutes * 60,
    voicemailDetection: outbound,
    voicemailAction: c.voicemail,
    voicemailMessage: c.voicemail === "leave_message" ? (c.voicemailMessage.trim() || `Hi, this is ${agent.name} from ${org.name}. Sorry we missed you — please call us back when you can.`) : null,
    extractionFields: EXTRACTION_FIELDS,
    transferNumber: toE164(c.transferNumber || org.settings.transferNumber || "", org.settings.defaultCountryCode) || null,
    endCallEnabled: true,
  };
}

/** The Integration Hub tools for one agent. Pure, so it is unit-tested. */
export function toolSpecs(orgId: string, providerAgentId: string, toolSecret: string, names: string[]): WebhookToolSpec[] {
  const base = `${publicBaseUrl()}/api/tools/${orgId}`;
  const secretHeader = { name: TOOL_SECRET_HEADER, value: toolSecret };
  const agentParam = { name: "agent_id", location: "body" as const, source: "constant" as const, value: providerAgentId };
  const phone = { name: "customer_phone", location: "body" as const, source: "dynamic_variable" as const, value: "customer_phone" };
  const m = (name: string, description: string, extra: { required?: boolean; enum?: string[] } = {}) =>
    ({ name, location: "body" as const, source: "model" as const, description, ...extra });
  const specs: Record<string, WebhookToolSpec> = {
    lookup_customer: {
      name: "lookup_customer", description: "Look up the caller before the call starts.", url: `${base}/lookup_customer`, timing: "pre_call", deadlineMs: 4000,
      parameters: [{ name: "phone", location: "body", source: "dynamic_variable", value: "system__caller_id" }, agentParam],
    },
    get_availability: {
      name: "get_availability", description: "Open arrival windows. Call before offering any time.", url: `${base}/get_availability`, sideEffect: "none", deadlineMs: 10_000,
      parameters: [m("day", "The day the customer wants, as they said it ('tomorrow', 'Saturday', '21 November'). Empty for the soonest."), m("job_type", "The service needed, e.g. 'AC repair'."), m("postal_code", "The service address postal code, if known."), phone, agentParam],
    },
    book_job: {
      name: "book_job", description: "Book the job in the window the customer chose. Only after get_availability and the customer's yes.", url: `${base}/book_job`, sideEffect: "unknown", deadlineMs: 20_000,
      parameters: [
        m("start", "The start value of the chosen window from get_availability (or the day and time as the customer said it).", { required: true }),
        m("job_type", "The service needed."), m("customer_name", "The customer's name, only if it is not on file."), m("street", "Service address street."), m("postal_code", "Service address postal code."),
        m("notes", "What the technician should know, in one or two sentences."), phone, agentParam,
      ],
    },
    reschedule_job: { name: "reschedule_job", description: "Move the customer's next appointment.", url: `${base}/reschedule_job`, sideEffect: "unknown", deadlineMs: 20_000, parameters: [m("start", "The start value of the new window.", { required: true }), phone, agentParam] },
    cancel_job: { name: "cancel_job", description: "Cancel the customer's next appointment, after they confirm.", url: `${base}/cancel_job`, sideEffect: "unknown", deadlineMs: 15_000, parameters: [m("reason", "Why, in a few words."), phone, agentParam] },
    create_lead: { name: "create_lead", description: "Save a caller who did not book (or wants a callback).", url: `${base}/create_lead`, sideEffect: "idempotent", deadlineMs: 10_000, parameters: [m("summary", "What they need and when to call back.", { required: true }), m("service", "The service asked about."), m("customer_name", "Their name if not on file."), phone, agentParam] },
    get_estimates: { name: "get_estimates", description: "The customer's open estimates.", url: `${base}/get_estimates`, sideEffect: "none", deadlineMs: 10_000, parameters: [phone, agentParam] },
    get_membership: { name: "get_membership", description: "The customer's membership status.", url: `${base}/get_membership`, sideEffect: "none", deadlineMs: 10_000, parameters: [phone, agentParam] },
    send_sms: { name: "send_sms", description: "Text the customer a short confirmation, address or link.", url: `${base}/send_sms`, sideEffect: "unknown", deadlineMs: 10_000, parameters: [m("message", "The text, under 300 characters.", { required: true }), phone, agentParam] },
    notify_team: {
      name: "notify_team", description: "Alert the office right away (emergency, unhappy customer, lost lead).", url: `${base}/notify_team`, sideEffect: "unknown", deadlineMs: 10_000,
      parameters: [m("kind", "Type of alert.", { enum: ["emergency", "unhappy_customer", "lost_lead", "info"], required: true }), m("message", "What happened, in one sentence.", { required: true }), phone, agentParam],
    },
  };
  return names.filter((n) => specs[n]).map((n) => ({ method: "POST", secretHeader, ...specs[n] }));
}

export async function createAgent(org: Org, input: z.infer<typeof createAgentSchema>): Promise<AgentRow> {
  const ws = await requireVoiceWorkspace(org.id);
  const dupe = await one("SELECT 1 AS x FROM agents WHERE org_id = $1 AND name = $2 AND status <> 'archived'", [org.id, input.name]);
  if (dupe) throw conflict("An agent with this name already exists.");
  const row = (await q("INSERT INTO agents (org_id, name, playbook, config) VALUES ($1, $2, $3, $4) RETURNING *", [org.id, input.name, input.playbook, JSON.stringify(input.config)]))[0];
  try {
    const created = await rasen.createAgent(ws, { ...providerConfig(org, toAgent(row)), name: input.name, resourceKey: `pine:${org.id}:${row.id}` }, { publish: false });
    return toAgent((await q("UPDATE agents SET provider_agent_id = $2, updated_at = now() WHERE id = $1 RETURNING *", [row.id, created.id]))[0]);
  } catch (err) {
    // Leave no half-made agent behind.
    await q("DELETE FROM agents WHERE id = $1", [row.id]);
    throw new HttpError(502, "voice_provider", `The voice provider refused the agent: ${rasen.describeRasenError(err)}`);
  }
}

export const updateAgentSchema = z.object({ name: z.string().trim().min(2).max(60).optional(), config: agentConfigSchema.partial().optional() });

export async function updateAgent(org: Org, id: string, patch: z.infer<typeof updateAgentSchema>): Promise<AgentRow> {
  const cur = await getAgent(org.id, id);
  if (cur.status === "archived") throw badRequest("This agent is archived.");
  const config = agentConfigSchema.parse({ ...cur.config, ...(patch.config || {}) });
  const name = patch.name ?? cur.name;
  const row = toAgent((await q("UPDATE agents SET name = $3, config = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING *", [org.id, id, name, JSON.stringify(config)]))[0]);
  if (row.providerAgentId) {
    const ws = await requireVoiceWorkspace(org.id);
    await rasen.updateAgentConfig(ws, row.providerAgentId, providerConfig(org, row), { publish: false });
  }
  return row;
}

async function attachTools(org: Org, ws: VoiceWorkspace, agent: AgentRow): Promise<void> {
  if (!hasPublicBaseUrl()) throw new HttpError(409, "no_public_url", "PUBLIC_BASE_URL must be a public https address before an agent can use the Integration Hub tools.");
  const names = agent.config.tools?.length ? agent.config.tools : toolsFor(agent.playbook);
  const specs = toolSpecs(org.id, agent.providerAgentId!, ws.toolSecret, names);
  const all = toolsFor("inbound_booking");
  await rasen.syncAgentTools(ws, agent.providerAgentId!, specs, { removeNames: all.filter((n) => !names.includes(n)) });
}

/** Validate, attach tools, publish. Records the result (or the provider's reason) on the row. */
export async function publishAgent(org: Org, id: string): Promise<AgentRow> {
  const agent = await getAgent(org.id, id);
  if (!agent.providerAgentId) throw badRequest("This agent has no voice-provider agent yet.");
  const ws = await requireVoiceWorkspace(org.id);
  try {
    await rasen.updateAgentConfig(ws, agent.providerAgentId, providerConfig(org, agent), { publish: false });
    await attachTools(org, ws, agent);
    const r = await rasen.publishAgent(ws, agent.providerAgentId);
    return toAgent((await q(
      "UPDATE agents SET status = 'live', live_version_id = $2, published_at = now(), publish_error = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [agent.id, r.liveVersionId]
    ))[0]);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const reason = rasen.describeRasenError(err);
    await q("UPDATE agents SET publish_error = $2, updated_at = now() WHERE id = $1", [agent.id, reason.slice(0, 1000)]);
    throw new HttpError(422, "publish_failed", `Not published: ${reason}`);
  }
}

export async function readiness(org: Org, id: string) {
  const agent = await getAgent(org.id, id);
  if (!agent.providerAgentId) return { ready: false, state: "missing", reasons: ["no provider agent"] };
  return rasen.getAgentReadiness(await requireVoiceWorkspace(org.id), agent.providerAgentId);
}

/** A hosted test-call link, so staff can talk to the agent in the browser before going live. */
export async function testCallLink(org: Org, id: string) {
  const agent = await getAgent(org.id, id);
  if (!agent.providerAgentId) throw badRequest("Publish the agent first.");
  return rasen.issueTestCallToken(await requireVoiceWorkspace(org.id), agent.providerAgentId);
}

export async function pauseAgent(org: Org, id: string): Promise<AgentRow> {
  const agent = await getAgent(org.id, id);
  const ws = await requireVoiceWorkspace(org.id);
  const numbers = await q("SELECT provider_number_id FROM phone_numbers WHERE org_id = $1 AND inbound_agent_id = $2", [org.id, id]);
  for (const n of numbers) await rasen.removeInboundAgent(ws, n.provider_number_id);
  await q("UPDATE phone_numbers SET inbound_agent_id = NULL WHERE org_id = $1 AND inbound_agent_id = $2", [org.id, id]);
  if (agent.providerAgentId) await rasen.stopActiveCallsForAgent(ws, agent.providerAgentId).catch(() => {});
  return toAgent((await q("UPDATE agents SET status = 'paused', updated_at = now() WHERE id = $1 RETURNING *", [id]))[0]);
}

export async function archiveAgent(org: Org, id: string): Promise<void> {
  const agent = await getAgent(org.id, id);
  const inUse = await one("SELECT 1 AS x FROM campaigns WHERE org_id = $1 AND agent_id = $2 AND status IN ('scheduled','running','paused')", [org.id, id]);
  if (inUse) throw conflict("A campaign is using this agent. Finish or cancel it first.");
  await pauseAgent(org, id);
  if (agent.providerAgentId) await rasen.archiveAgent(await requireVoiceWorkspace(org.id), agent.providerAgentId);
  await q("UPDATE agents SET status = 'archived', updated_at = now() WHERE id = $1", [id]);
}

/** Re-publish every live agent of an org — after its business facts change. */
export async function republishLiveAgents(orgId: string): Promise<{ ok: number; failed: number }> {
  const org = await getOrg(orgId);
  let ok = 0, failed = 0;
  for (const a of await listAgents(orgId)) {
    if (a.status !== "live") continue;
    try { await publishAgent(org, a.id); ok++; } catch { failed++; }
  }
  return { ok, failed };
}
