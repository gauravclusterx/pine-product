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
  const sources = await rasen.listAgentKnowledge(ws, agent.providerAgentId!);
  res.json({ sources, pending: sources.some((s) => ["pending", "ingesting"].includes(s.state)) });
}));

knowledgeRouter.post("/agents/:id/knowledge", manager, h(async (req, res) => {
  const b = parse(z.union([
    z.object({ kind: z.literal("url"), url: httpsUrl, name: z.string().trim().max(200).optional(), publishWhenReady: z.boolean().default(true) }),
    z.object({ kind: z.literal("text"), name: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(262_144), publishWhenReady: z.boolean().default(true) }),
  ]), req.body);
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const src = await rasen.addAgentKnowledge(ws, agent.providerAgentId!, b.kind === "url" ? { kind: "url", url: b.url, name: b.name } : { kind: "text", text: b.text, name: b.name });
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
  if (b.publishWhenReady) await scheduleKnowledgePublish(req.auth!.orgId, agent.id);
  await audit(req.auth!.orgId, req.auth!.userId, "agent.knowledge_added", { agentId: agent.id, kind: "file", sourceId: src.id });
  res.status(202).json({ source: src });
}));

knowledgeRouter.delete("/agents/:id/knowledge/:sourceId", manager, h(async (req, res) => {
  const { agent, ws } = await providerAgent(req.auth!.orgId, parse(uuid, P(req).id));
  const sourceId = String(P(req).sourceId || "");
  if (!/^[A-Za-z0-9_\-]{3,80}$/.test(sourceId)) throw badRequest("Unknown source.");
  await rasen.removeAgentKnowledge(ws, agent.providerAgentId!, sourceId, String(req.query.relation || "") || null);
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
