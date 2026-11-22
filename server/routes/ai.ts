/**
 * AI keys in the admin panel — same as the CRM admin's "AI keys": an OpenAI key + model and an
 * Anthropic key + model, platform-wide and per customer. Keys are write-only: answers say whether a
 * key is set and its last four characters, never the key. A new key is checked with its provider
 * before it is saved.
 *
 *   GET  /admin/ai-keys                   platform keys + model lists
 *   PUT  /admin/ai-keys                   { openaiKey?, openaiModel?, anthropicKey?, anthropicModel? } ("" removes a key)
 *   GET  /admin/customers/:id/ai-keys     one customer's own keys
 *   PUT  /admin/customers/:id/ai-keys     same body
 *   GET  /ai/status                       customer app: is AI available here?
 */
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { enqueue } from "../queue/queue.js";
import { h, P, parse, uuid } from "../http.js";
import { audit, requirePlatformAdmin, requireRole } from "../auth/auth.js";
import {
  aiAvailable, ANTHROPIC_MODELS, OPENAI_MODELS, orgKeyStatus, platformKeyStatus, setOrgKeys, setPlatformKeys, testKey, type KeyPatch,
} from "../modules/ai.js";

export const aiRouter = Router();
const body = z.object({
  openaiKey: z.string().trim().max(300).optional(),
  openaiModel: z.string().trim().max(80).optional(),
  anthropicKey: z.string().trim().max(300).optional(),
  anthropicModel: z.string().trim().max(80).optional(),
  skipTest: z.boolean().optional(),
});

/**
 * Check new keys with their provider (with the model chosen), then save. A wrong key (401/403,
 * unknown model) is refused. A busy provider (429 rate limit, 5xx) means the key itself was
 * accepted, so it is saved with a warning instead of being lost.
 */
async function checkAndPatch(b: z.infer<typeof body>, current: { openai: { model: string }; anthropic: { model: string } }): Promise<{ patch: KeyPatch; warnings: string[] }> {
  const p: KeyPatch = {};
  const warnings: string[] = [];
  if (b.openaiModel !== undefined) p.openaiModel = b.openaiModel;
  if (b.anthropicModel !== undefined) p.anthropicModel = b.anthropicModel;
  if (b.openaiKey !== undefined) p.openaiKey = b.openaiKey || null;
  if (b.anthropicKey !== undefined) p.anthropicKey = b.anthropicKey || null;
  const check = async (name: string, provider: "openai" | "anthropic", key: string | null | undefined, model: string) => {
    if (!key || b.skipTest) return;
    try { await testKey(provider, key, model); }
    catch (e) {
      const msg = (e as Error).message || "";
      if (/(429|500|502|503|529)|rate.?limit|overloaded/i.test(msg)) warnings.push(`${name} is busy right now (${msg.slice(0, 80)}). The key was saved; it will be used when ${name} answers again.`);
      else throw badRequest(`${name} did not accept this key/model: ${msg.slice(0, 300)}`);
    }
  };
  await check("OpenAI", "openai", p.openaiKey, p.openaiModel || current.openai.model);
  await check("Anthropic", "anthropic", p.anthropicKey, p.anthropicModel || current.anthropic.model);
  return { patch: p, warnings };
}

aiRouter.get("/admin/ai-keys", requirePlatformAdmin, h(async (_req, res) => {
  res.json({ ...(await platformKeyStatus()), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.put("/admin/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  const b = parse(body, req.body);
  const { patch, warnings } = await checkAndPatch(b, await platformKeyStatus());
  await setPlatformKeys(patch);
  if (patch.openaiKey || patch.anthropicKey) await enqueue("ai.backfill", {}, { dedupeKey: `ai-backfill:all:${Math.floor(Date.now() / 60_000)}` });
  await audit(null, req.auth!.userId, "admin.ai_keys_changed", { scope: "platform", openaiKey: b.openaiKey !== undefined, anthropicKey: b.anthropicKey !== undefined, openaiModel: b.openaiModel, anthropicModel: b.anthropicModel });
  res.json({ ...(await platformKeyStatus()), warnings, models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.get("/admin/customers/:id/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  res.json({ ...(await orgKeyStatus(parse(uuid, P(req).id))), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.put("/admin/customers/:id/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const b = parse(body, req.body);
  const { patch, warnings } = await checkAndPatch(b, await orgKeyStatus(id));
  await setOrgKeys(id, patch);
  if (patch.openaiKey || patch.anthropicKey) await enqueue("ai.backfill", { orgId: id }, { orgId: id, dedupeKey: `ai-backfill:${id}:${Math.floor(Date.now() / 60_000)}` });
  await audit(id, req.auth!.userId, "admin.ai_keys_changed", { scope: "customer", openaiKey: b.openaiKey !== undefined, anthropicKey: b.anthropicKey !== undefined, openaiModel: b.openaiModel, anthropicModel: b.anthropicModel });
  res.json({ ...(await orgKeyStatus(id)), warnings, models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.get("/ai/status", requireRole("viewer"), h(async (req, res) => {
  res.json({ available: await aiAvailable(req.auth!.orgId) });
}));
