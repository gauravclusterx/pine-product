/**
 * Agent knowledge and versions — Rasen's knowledge library (docs.rasen.ai/guides/knowledge):
 * a website, text or a document becomes something the agent answers from. Sources ingest in the
 * background; when every source is ready the agent is published (if asked, or if it is already
 * live), so "enter the website → the agent is ready" needs no further clicks.
 *
 *   GET    /agents/:id/knowledge                       the library with each source's state
 *   POST   /agents/:id/knowledge                       { kind: "url", url } | { kind: "text", name, text }, publishWhenReady?
 *   POST   /agents/:id/knowledge/upload                { name, filename, dataBase64 } (PDF, DOCX, MD, TXT ≤ 20 MB)
 *   DELETE /agents/:id/knowledge/:sourceId?relation=   take a source out of the library
 *   POST   /agents/:id/knowledge/:sourceId/refresh     fetch a web page again
 *   POST   /agents/from-website                        { name, playbook, url } → agent + website knowledge + publish when ready
 *   GET    /agents/:id/versions, POST /agents/:id/rollback { versionId }
 */
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { h, P, parse, uuid } from "../http.js";
import { audit, requireRole } from "../auth/auth.js";
import * as rasen from "../voice/rasen/service.js";
import * as agents from "../modules/agents.js";
import { getOrg } from "../modules/orgs.js";
import { requireVoiceWorkspace } from "../modules/voiceWorkspace.js";
import { enqueue } from "../queue/queue.js";
import { q } from "../db/pool.js";

export const knowledgeRouter = Router();

/** Record a source added from Pine (the CRM keeps knowledge in its own DB too). */
async function recordSource(orgId: string, userId: string, src: rasen.KnowledgeSource, scope: "workspace" | "agent", agentId: string | null, url?: string | null) {
  await q(
    `INSERT INTO knowledge_sources (org_id, provider_source_id, agent_id, scope, kind, name, url, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, provider_source_id) DO UPDATE SET deleted_at = NULL, deleted_by = NULL`,
    [orgId, src.id, agentId, scope, src.kind || "", src.name || "", url ?? src.url ?? null, userId]
  );
}
async function recordDeleted(orgId: string, userId: string, providerSourceId: string) {
  await q(
    `INSERT INTO knowledge_sources (org_id, provider_source_id, scope, kind, name, deleted_at, deleted_by) VALUES ($1, $2, 'workspace', '', '', now(), $3)
     ON CONFLICT (org_id, provider_source_id) DO UPDATE SET deleted_at = now(), deleted_by = $3`,
    [orgId, providerSourceId, userId]
  );
}
const viewer = requireRole("viewer");
const manager = requireRole("manager");

const httpsUrl = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "Use an https:// address.");
const ALLOWED = /\.(pdf|docx|md|markdown|txt)$/i;

async function providerAgent(orgId: string, id: string) {
  const agent = await agents.getAgent(orgId, id);
  if (!agent.providerAgentId) throw badRequest("This agent is not set up at the voice provider yet.");
  return { agent, ws: await requireVoiceWorkspace(orgId) };
}

/** Publish the agent as soon as every source in its library is ready (a job polls the provider). */
export async function scheduleKnowledgePublish(orgId: string, agentId: string, delaySeconds = 20): Promise<void> {
  await enqueue("agent.knowledge_publish", { agentId, tries: 0 }, { orgId, runAt: new Date(Date.now() + delaySeconds * 1000), dedupeKey: `kb-publish:${agentId}:${Math.floor(Date.now() / 60_000)}` });
}

knowledgeRouter.get("/agents/:id/knowledge", viewer, h(async (req, res) => {
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const gone = new Set((await q("SELECT provider_source_id FROM knowledge_sources WHERE org_id = $1 AND deleted_at IS NOT NULL", [req.auth!.orgId])).map((r) => r.provider_source_id));
  const sources = (await rasen.listAgentKnowledge(ws, agent.providerAgentId!)).filter((s) => !gone.has(s.id) && s.state !== "archived");
  res.json({ sources, pending: sources.some((s) => ["pending", "ingesting"].includes(s.state)) });
}));

knowledgeRouter.post("/agents/:id/knowledge", manager, h(async (req, res) => {
  const b = parse(z.union([
    z.object({ kind: z.literal("url"), url: httpsUrl, name: z.string().trim().max(200).optional(), publishWhenReady: z.boolean().default(true) }),
    z.object({ kind: z.literal("text"), name: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(262_144), publishWhenReady: z.boolean().default(true) }),
  ]), req.body);
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const src = await rasen.addAgentKnowledge(ws, agent.providerAgentId!, b.kind === "url" ? { kind: "url", url: b.url, name: b.name } : { kind: "text", text: b.text, name: b.name });
  await recordSource(req.auth!.orgId, req.auth!.userId, src, "agent", agent.id, b.kind === "url" ? b.url : null);
  if (b.publishWhenReady) await scheduleKnowledgePublish(req.auth!.orgId, agent.id);
  await audit(req.auth!.orgId, req.auth!.userId, "agent.knowledge_added", { agentId: agent.id, kind: b.kind, sourceId: src.id });
  res.status(202).json({ source: src });
}));

knowledgeRouter.post("/agents/:id/knowledge/upload", manager, h(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(200), filename: z.string().trim().min(3).max(200), dataBase64: z.string().min(4), publishWhenReady: z.boolean().default(true) }), req.body);
  if (!ALLOWED.test(b.filename)) throw badRequest("Upload a PDF, DOCX, Markdown or text file.");
  const file = Buffer.from(b.dataBase64, "base64");
  if (file.length > 20 * 1024 * 1024) throw badRequest("The file is larger than 20 MB.");
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const src = await rasen.uploadAgentKnowledgeFile(ws, agent.providerAgentId!, b.name, file, b.filename);
  await recordSource(req.auth!.orgId, req.auth!.userId, src, "agent", agent.id);
  if (b.publishWhenReady) await scheduleKnowledgePublish(req.auth!.orgId, agent.id);
  await audit(req.auth!.orgId, req.auth!.userId, "agent.knowledge_added", { agentId: agent.id, kind: "file", sourceId: src.id });
  res.status(202).json({ source: src });
}));

knowledgeRouter.delete("/agents/:id/knowledge/:sourceId", manager, h(async (req, res) => {
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const sourceId = String(P(req).sourceId || "");
  if (!/^[A-Za-z0-9_\-]{3,80}$/.test(sourceId)) throw badRequest("Unknown source.");
  await rasen.removeAgentKnowledge(ws, agent.providerAgentId!, sourceId, String(req.query.relation || "") || null);
  if (String(req.query.relation || "") !== "shared") await recordDeleted(req.auth!.orgId, req.auth!.userId, sourceId);
  await scheduleKnowledgePublish(req.auth!.orgId, agent.id, 5);
  await audit(req.auth!.orgId, req.auth!.userId, "agent.knowledge_removed", { agentId: agent.id, sourceId });
  res.json({ ok: true });
}));

knowledgeRouter.post("/agents/:id/knowledge/:sourceId/refresh", manager, h(async (req, res) => {
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const sourceId = String(P(req).sourceId || "");
  if (!/^[A-Za-z0-9_\-]{3,80}$/.test(sourceId)) throw badRequest("Unknown source.");
  const src = await rasen.refreshKnowledgeSource(ws, sourceId);
  await scheduleKnowledgePublish(req.auth!.orgId, agent.id);
  res.json({ source: src });
}));

/** "Enter your website and the agent is ready": create the agent, give it the site, publish when ingested. */
knowledgeRouter.post("/agents/from-website", manager, h(async (req, res) => {
  const b = parse(agents.createAgentSchema.extend({ url: httpsUrl }), req.body);
  const org = await getOrg(req.auth!.orgId);
  const { url, ...input } = b;
  const created = await agents.createAgent(org, input);
  const ws = await requireVoiceWorkspace(org.id);
  if (!created.providerAgentId) throw badRequest("The agent was created but the voice provider did not accept it yet. Open it and press Publish.");
  const src = await rasen.addAgentKnowledge(ws, created.providerAgentId, { kind: "url", url, name: new URL(url).hostname });
  await recordSource(org.id, req.auth!.userId, src, "agent", created.id, url);
  await q("UPDATE agents SET config = config || $2, updated_at = now() WHERE id = $1", [created.id, JSON.stringify({ website: url })]);
  await scheduleKnowledgePublish(org.id, created.id);
  await audit(org.id, req.auth!.userId, "agent.created_from_website", { agentId: created.id, url });
  res.status(201).json({ agent: created, source: src });
}));

knowledgeRouter.get("/agents/:id/versions", viewer, h(async (req, res) => {
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  res.json({ versions: await rasen.listAgentVersions(ws, agent.providerAgentId!) });
}));

knowledgeRouter.post("/agents/:id/rollback", manager, h(async (req, res) => {
  const { versionId } = parse(z.object({ versionId: z.string().regex(/^[A-Za-z0-9_\-]{3,80}$/) }), req.body);
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const live = await rasen.rollbackAgent(ws, agent.providerAgentId!, versionId);
  await q("UPDATE agents SET live_version_id = $2, status = 'live', updated_at = now() WHERE id = $1", [agent.id, live]);
  await audit(req.auth!.orgId, req.auth!.userId, "agent.rolled_back", { agentId: agent.id, versionId });
  res.json({ ok: true, liveVersionId: live });
}));

// ── workspace library ────────────────────────────────────────────────────────

const sourceId = (req: any) => { const v = String(P(req).sourceId || ""); if (!/^[A-Za-z0-9_\-]{3,80}$/.test(v)) throw badRequest("Unknown source."); return v; };

/** Which of this business's agents use each source. Libraries are read in parallel and cached a minute (the provider limits reads). */
const usageCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof readUsage>> }>();
async function readUsage(orgId: string, ws: any) {
  const mine = await q("SELECT id, name, provider_agent_id FROM agents WHERE org_id = $1 AND status <> 'archived' AND provider_agent_id IS NOT NULL ORDER BY name", [orgId]);
  const libs = await Promise.all(mine.map((a) => rasen.listAgentKnowledge(ws, a.provider_agent_id).catch(() => [] as rasen.KnowledgeSource[])));
  const by = new Map<string, Array<{ id: string; name: string }>>();
  mine.forEach((a, i) => { for (const s of libs[i]) by.set(s.id, [...(by.get(s.id) || []), { id: a.id, name: a.name }]); });
  return { agents: mine.map((a) => ({ id: a.id, name: a.name })), by, mine };
}
async function usage(orgId: string, ws: any, fresh = false) {
  const hit = usageCache.get(orgId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await readUsage(orgId, ws);
  usageCache.set(orgId, { at: Date.now(), value });
  return value;
}

async function setAgents(orgId: string, ws: any, src: string, wanted: string[]) {
  const { by, mine } = await usage(orgId, ws, true);
  const now = new Set((by.get(src) || []).map((a) => a.id));
  for (const a of mine) {
    const want = wanted.includes(a.id);
    if (want && !now.has(a.id)) { await rasen.attachKnowledge(ws, a.provider_agent_id, src); await scheduleKnowledgePublish(orgId, a.id); }
    if (!want && now.has(a.id)) { await rasen.detachKnowledge(ws, a.provider_agent_id, src); await scheduleKnowledgePublish(orgId, a.id, 5); }
  }
  usageCache.delete(orgId);
}

knowledgeRouter.get("/knowledge", viewer, h(async (req, res) => {
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const sources = await rasen.listWorkspaceKnowledge(ws);
  const agentsHere = await q("SELECT id, name FROM agents WHERE org_id = $1 AND status <> 'archived' AND provider_agent_id IS NOT NULL ORDER BY name", [req.auth!.orgId]);
  const u = req.query.usage === "1" ? await usage(req.auth!.orgId, ws) : null;
  const rows = await q("SELECT provider_source_id, deleted_at FROM knowledge_sources WHERE org_id = $1", [req.auth!.orgId]);
  const ours = new Set(rows.filter((r) => !r.deleted_at).map((r) => r.provider_source_id));
  const deleted = new Set(rows.filter((r) => r.deleted_at).map((r) => r.provider_source_id));
  res.json({
    sources: sources.filter((s) => !deleted.has(s.id)).map((s) => ({ ...s, agents: u ? u.by.get(s.id) || [] : null, fromPine: ours.has(s.id) })),
    agents: agentsHere,
    pending: sources.some((s) => ["pending", "ingesting"].includes(s.state)),
  });
}));

const agentIds = z.array(z.string().uuid()).max(100).default([]);

knowledgeRouter.post("/knowledge", manager, h(async (req, res) => {
  const b = parse(z.union([
    z.object({ kind: z.literal("url"), url: httpsUrl, name: z.string().trim().max(200).optional(), agentIds }),
    z.object({ kind: z.literal("text"), name: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(262_144), agentIds }),
  ]), req.body);
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const src = await rasen.addWorkspaceKnowledge(ws, b.kind === "url" ? { kind: "url", url: b.url, name: b.name } : { kind: "text", text: b.text, name: b.name });
  await recordSource(req.auth!.orgId, req.auth!.userId, src, "workspace", null, b.kind === "url" ? b.url : null);
  if (b.agentIds.length) await setAgents(req.auth!.orgId, ws, src.id, b.agentIds);
  await audit(req.auth!.orgId, req.auth!.userId, "knowledge.added", { kind: b.kind, sourceId: src.id, agents: b.agentIds.length });
  res.status(202).json({ source: src });
}));

knowledgeRouter.post("/knowledge/upload", manager, h(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(200), filename: z.string().trim().min(3).max(200), dataBase64: z.string().min(4), agentIds }), req.body);
  if (!ALLOWED.test(b.filename)) throw badRequest("Upload a PDF, DOCX, Markdown or text file.");
  const file = Buffer.from(b.dataBase64, "base64");
  if (file.length > 20 * 1024 * 1024) throw badRequest("The file is larger than 20 MB.");
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const src = await rasen.uploadWorkspaceKnowledge(ws, b.name, file, b.filename);
  await recordSource(req.auth!.orgId, req.auth!.userId, src, "workspace", null);
  if (b.agentIds.length) await setAgents(req.auth!.orgId, ws, src.id, b.agentIds);
  await audit(req.auth!.orgId, req.auth!.userId, "knowledge.added", { kind: "file", sourceId: src.id, agents: b.agentIds.length });
  res.status(202).json({ source: src });
}));

knowledgeRouter.put("/knowledge/:sourceId/agents", manager, h(async (req, res) => {
  const { agentIds: ids } = parse(z.object({ agentIds }), req.body);
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  await setAgents(req.auth!.orgId, ws, sourceId(req), ids);
  await audit(req.auth!.orgId, req.auth!.userId, "knowledge.agents_changed", { sourceId: sourceId(req), agents: ids.length });
  res.json({ ok: true });
}));

knowledgeRouter.post("/knowledge/:sourceId/refresh", manager, h(async (req, res) => {
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  res.json({ source: await rasen.refreshKnowledgeSource(ws, sourceId(req)) });
}));

knowledgeRouter.delete("/knowledge/:sourceId", manager, h(async (req, res) => {
  const ws = await requireVoiceWorkspace(req.auth!.orgId);
  const id = sourceId(req);
  await rasen.archiveKnowledge(ws, id);
  usageCache.delete(req.auth!.orgId);
  await recordDeleted(req.auth!.orgId, req.auth!.userId, id);
  // Taking it out of each agent's library (and republishing) can take a while: do it in the background.
  await enqueue("knowledge.detach_all", { sourceId: id }, { orgId: req.auth!.orgId, dedupeKey: `kb-detach:${id}` });
  await audit(req.auth!.orgId, req.auth!.userId, "knowledge.removed", { sourceId: id });
  res.json({ ok: true });
}));

/** Background: take an archived source out of every agent that used it. */
export async function detachEverywhere(orgId: string, sourceIdValue: string): Promise<void> {
  const ws = await requireVoiceWorkspace(orgId);
  await setAgents(orgId, ws, sourceIdValue, []);
}
