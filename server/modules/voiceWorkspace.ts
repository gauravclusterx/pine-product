/**
 * An org's voice workspace: its own voice-provider key (one per client, entered by platform
 * staff), the secret its webhooks are signed with, and the secret its agents' tools present to
 * the Integration Hub. Everything is stored encrypted and opened only here.
 */
import { one, q } from "../db/pool.js";
import { decrypt, encrypt, hashSecret, newSecret } from "../lib/crypto.js";
import { badRequest, conflict, HttpError } from "../lib/errors.js";
import { hasPublicBaseUrl, publicBaseUrl } from "../config.js";
import { log } from "../lib/logger.js";
import * as rasen from "../voice/rasen/service.js";

export interface VoiceWorkspace {
  orgId: string;
  apiKey: string;
  workspaceId: string;
  webhookSecret: string | null;
  toolSecret: string;
}

/** The decrypted workspace of an org, or null when none is connected. */
export async function findVoiceWorkspace(orgId: string): Promise<VoiceWorkspace | null> {
  const row = await one("SELECT * FROM voice_workspaces WHERE org_id = $1", [orgId]);
  if (!row) return null;
  return {
    orgId,
    apiKey: decrypt(row.api_key_enc),
    workspaceId: row.workspace_id,
    webhookSecret: row.webhook_secret_enc ? decrypt(row.webhook_secret_enc) : null,
    toolSecret: decrypt(row.tool_secret_enc),
  };
}

/** The workspace, or a 409 the UI turns into "ask us to connect calling". */
export async function requireVoiceWorkspace(orgId: string): Promise<VoiceWorkspace> {
  const ws = await findVoiceWorkspace(orgId);
  if (!ws) throw new HttpError(409, "voice_not_connected", "Calling is not connected for this workspace yet.");
  return ws;
}

export async function voiceStatus(orgId: string): Promise<{ connected: boolean; workspaceId: string | null; connectedAt: Date | null; webhook: boolean }> {
  const row = await one("SELECT workspace_id, connected_at, webhook_endpoint_id FROM voice_workspaces WHERE org_id = $1", [orgId]);
  return { connected: !!row, workspaceId: row?.workspace_id ?? null, connectedAt: row?.connected_at ?? null, webhook: !!row?.webhook_endpoint_id };
}

export function webhookUrl(): string {
  return `${publicBaseUrl()}/api/webhooks/voice`;
}

/**
 * Connect (or replace) an org's voice key. The key is checked against the provider first: it
 * must be valid, carry the capabilities the platform needs, and belong to a workspace no other
 * org uses — two orgs sharing a workspace would see each other's calls.
 */
export async function connectVoiceWorkspace(orgId: string, rawKey: string, opts: { webhookSecret?: string } = {}): Promise<{ workspaceId: string; webhookRegistered: boolean; note: string | null }> {
  const key = String(rawKey || "").trim();
  if (key.length < 12) throw badRequest("Paste the full API key.");
  const check = await rasen.inspectRasenApiKey(key);
  if (!check.valid || !check.context) throw badRequest(check.reason || "The voice provider rejected this key.");
  if (check.missingCapabilities.length) {
    throw badRequest(`This key is missing permissions: ${check.missingCapabilities.join(", ")}. Create a key with full access.`);
  }
  const workspaceId = check.context.workspace_id;
  const taken = await one("SELECT org_id FROM voice_workspaces WHERE workspace_id = $1 AND org_id <> $2", [workspaceId, orgId]);
  if (taken) throw conflict("This voice workspace is already connected to another client. Each client needs its own.");

  const existing = await one("SELECT tool_secret_enc, webhook_secret_enc, webhook_endpoint_id, workspace_id FROM voice_workspaces WHERE org_id = $1", [orgId]);
  const sameWorkspace = existing?.workspace_id === workspaceId;
  // The tool secret is kept across a key rotation: published agents already carry it.
  const toolSecret = existing ? decrypt(existing.tool_secret_enc) : newSecret();

  let webhookSecret: string | null = opts.webhookSecret?.trim() || (sameWorkspace && existing?.webhook_secret_enc ? decrypt(existing.webhook_secret_enc) : null);
  let endpointId: string | null = sameWorkspace ? existing?.webhook_endpoint_id ?? null : null;
  let note: string | null = null;
  if (hasPublicBaseUrl()) {
    try {
      const ep = await rasen.ensureWebhookEndpoint(key, webhookUrl());
      endpointId = ep.id;
      // The signing secret is shown once, when the endpoint is created.
      if (ep.secret) webhookSecret = ep.secret;
      if (!webhookSecret) note = "The call-events webhook already existed, so its signing secret could not be read. Paste the secret, or delete the endpoint at the provider and reconnect.";
    } catch (err) {
      log.warn({ orgId, err: rasen.describeRasenError(err) }, "webhook registration failed");
      note = "The key was saved, but the call-events webhook could not be registered: " + rasen.describeRasenError(err);
    }
  } else {
    note = "PUBLIC_BASE_URL is not a public https address, so call events cannot reach this server. Calls are synced by polling until it is set.";
  }

  await q(
    `INSERT INTO voice_workspaces (org_id, api_key_enc, workspace_id, webhook_secret_enc, webhook_endpoint_id, tool_secret_hash, tool_secret_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, workspace_id = EXCLUDED.workspace_id,
       webhook_secret_enc = EXCLUDED.webhook_secret_enc, webhook_endpoint_id = EXCLUDED.webhook_endpoint_id, updated_at = now()`,
    [orgId, encrypt(key), workspaceId, webhookSecret ? encrypt(webhookSecret) : null, endpointId, hashSecret(toolSecret), encrypt(toolSecret)]
  );
  return { workspaceId, webhookRegistered: !!endpointId && !!webhookSecret, note };
}

export async function disconnectVoiceWorkspace(orgId: string): Promise<void> {
  await q("DELETE FROM voice_workspaces WHERE org_id = $1", [orgId]);
}

/** Which org a webhook belongs to, by the provider's workspace id. */
export async function orgForWorkspace(workspaceId: string): Promise<{ orgId: string; webhookSecret: string | null } | null> {
  const row = await one("SELECT org_id, webhook_secret_enc FROM voice_workspaces WHERE workspace_id = $1", [workspaceId]);
  if (!row) return null;
  return { orgId: row.org_id, webhookSecret: row.webhook_secret_enc ? decrypt(row.webhook_secret_enc) : null };
}
