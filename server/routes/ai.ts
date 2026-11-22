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

/** Check new keys with their provider (with the model chosen), then save. */
async function checkAndPatch(b: z.infer<typeof body>, current: { openai: { model: string }; anthropic: { model: string } }): Promise<KeyPatch> {
  const p: KeyPatch = {};
  if (b.openaiModel !== undefined) p.openaiModel = b.openaiModel;
  if (b.anthropicModel !== undefined) p.anthropicModel = b.anthropicModel;
  if (b.openaiKey !== undefined) p.openaiKey = b.openaiKey || null;
  if (b.anthropicKey !== undefined) p.anthropicKey = b.anthropicKey || null;
  if (!b.skipTest) {
    try {
      if (p.openaiKey) await testKey("openai", p.openaiKey, p.openaiModel || current.openai.model);
    } catch (e) { throw badRequest(`OpenAI did not accept this key/model: ${(e as Error).message}`); }
    try {
      if (p.anthropicKey) await testKey("anthropic", p.anthropicKey, p.anthropicModel || current.anthropic.model);
    } catch (e) { throw badRequest(`Anthropic did not accept this key/model: ${(e as Error).message}`); }
  }
  return p;
}

aiRouter.get("/admin/ai-keys", requirePlatformAdmin, h(async (_req, res) => {
  res.json({ ...(await platformKeyStatus()), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.put("/admin/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  const b = parse(body, req.body);
  await setPlatformKeys(await checkAndPatch(b, await platformKeyStatus()));
  await audit(null, req.auth!.userId, "admin.ai_keys_changed", { scope: "platform", openaiKey: b.openaiKey !== undefined, anthropicKey: b.anthropicKey !== undefined, openaiModel: b.openaiModel, anthropicModel: b.anthropicModel });
  res.json({ ...(await platformKeyStatus()), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.get("/admin/customers/:id/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  res.json({ ...(await orgKeyStatus(parse(uuid, P(req).id))), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.put("/admin/customers/:id/ai-keys", requirePlatformAdmin, h(async (req, res) => {
  const id = parse(uuid, P(req).id);
  const b = parse(body, req.body);
  await setOrgKeys(id, await checkAndPatch(b, await orgKeyStatus(id)));
  await audit(id, req.auth!.userId, "admin.ai_keys_changed", { scope: "customer", openaiKey: b.openaiKey !== undefined, anthropicKey: b.anthropicKey !== undefined, openaiModel: b.openaiModel, anthropicModel: b.anthropicModel });
  res.json({ ...(await orgKeyStatus(id)), models: { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS } });
}));

aiRouter.get("/ai/status", requireRole("viewer"), h(async (req, res) => {
  res.json({ available: await aiAvailable(req.auth!.orgId) });
}));
