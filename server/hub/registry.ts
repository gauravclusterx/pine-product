/**
 * Which connectors exist, and the org's configured integrations (credentials stored encrypted).
 */
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { decrypt, encrypt, hashSecret, newSecret } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import type { Org } from "../modules/orgs.js";
import { servicetitan } from "./connectors/servicetitan.js";
import { housecallPro } from "./connectors/housecallPro.js";
import { jobber } from "./connectors/jobber.js";
import { salesforce } from "./connectors/salesforce.js";
import { acculynx, genericRest, googleCalendar, native, outlook } from "./connectors/others.js";
import { cacheFor, fetchHttp } from "./http.js";
import type { ConnectorContext, CrmConnector, CredentialField, HttpFn } from "./types.js";

export const CRM_CONNECTORS: Record<string, CrmConnector> = Object.fromEntries(
  [native, servicetitan, housecallPro, jobber, salesforce, acculynx, genericRest, googleCalendar, outlook].map((c) => [c.kind, c])
);

/** Messaging, alerting and lead-source integrations (not schedule connectors). */
export interface ChannelSpec { kind: string; label: string; group: "messaging" | "alerts" | "leads"; maturity: "live" | "unverified"; credentialFields: CredentialField[]; settingFields?: CredentialField[]; accessNote?: string; inbound?: boolean }
export const CHANNELS: Record<string, ChannelSpec> = {
  twilio: {
    kind: "twilio", label: "Twilio SMS", group: "messaging", maturity: "unverified", inbound: true,
    credentialFields: [{ key: "accountSid", label: "Account SID", required: true }, { key: "authToken", label: "Auth token", secret: true, required: true }],
    settingFields: [{ key: "messagingServiceSid", label: "Messaging Service SID", required: true }],
    accessNote: "US texting needs A2P 10DLC brand + campaign registration (or toll-free verification) before any message is delivered. For replies and the SMS agent, set the number's \"A message comes in\" webhook in Twilio to the URL shown after connecting.",
  },
  slack: {
    kind: "slack", label: "Slack", group: "alerts", maturity: "unverified",
    credentialFields: [{ key: "webhookUrl", label: "Incoming webhook URL", secret: true, help: "Or a bot token below." }, { key: "botToken", label: "Bot token (xoxb-…)", secret: true }],
    settingFields: [{ key: "channel", label: "Channel (with a bot token)" }],
  },
  email_alerts: {
    kind: "email_alerts", label: "Email alerts", group: "alerts", maturity: "unverified",
    credentialFields: [{ key: "apiKey", label: "Transactional email API key (Resend)", secret: true, required: true }],
    settingFields: [{ key: "from", label: "From address", required: true }, { key: "to", label: "Send alerts to", required: true }],
  },
  google_lsa: {
    kind: "google_lsa", label: "Google Local Services Ads", group: "leads", maturity: "unverified",
    credentialFields: [
      { key: "developerToken", label: "Google Ads developer token", secret: true, required: true },
      { key: "clientId", label: "OAuth client ID", required: true }, { key: "clientSecret", label: "OAuth client secret", secret: true, required: true },
      { key: "refreshToken", label: "Refresh token", secret: true, required: true },
    ],
    settingFields: [{ key: "customerId", label: "Ads customer ID (client)", required: true }, { key: "loginCustomerId", label: "Manager account ID", required: true }],
    accessNote: "Polled every minute — Google sends no push. The client links their LSA account to our manager account.",
  },
  meta: {
    kind: "meta", label: "Meta lead forms", group: "leads", maturity: "unverified", inbound: true,
    credentialFields: [{ key: "pageAccessToken", label: "Page access token", secret: true, required: true }, { key: "appSecret", label: "App secret", secret: true, required: true }],
    settingFields: [{ key: "pageId", label: "Page ID", required: true }],
    accessNote: "Needs Meta App Review for leads_retrieval. The webhook carries only the lead id; we fetch the lead.",
  },
  yelp: { kind: "yelp", label: "Yelp Leads", group: "leads", maturity: "unverified", inbound: true, credentialFields: [{ key: "accessToken", label: "OAuth access token", secret: true, required: true }], accessNote: "Yelp Leads API access is limited to advertising partners. Until then use the email fallback." },
  angi: { kind: "angi", label: "Angi", group: "leads", maturity: "unverified", inbound: true, credentialFields: [], accessNote: "Angi posts each lead to the webhook URL shown after connecting, with the X-API-KEY shown once." },
  thumbtack: { kind: "thumbtack", label: "Thumbtack", group: "leads", maturity: "unverified", inbound: true, credentialFields: [], accessNote: "Needs Thumbtack partnership credentials; Thumbtack calls our lead endpoint." },
  web_form: { kind: "web_form", label: "Website form", group: "leads", maturity: "live", inbound: true, credentialFields: [] },
  email_parse: { kind: "email_parse", label: "Lead emails (fallback)", group: "leads", maturity: "live", inbound: true, credentialFields: [], accessNote: "Forward lead notification emails to the inbound address; we parse name, phone, service and postal code." },
};

export function specOf(kind: string): { label: string; credentialFields: CredentialField[]; settingFields?: CredentialField[]; inbound?: boolean } | null {
  return CRM_CONNECTORS[kind] || CHANNELS[kind] || null;
}

export interface IntegrationRow {
  id: string; orgId: string; kind: string; status: string; settings: Record<string, any>;
  credentials: Record<string, any>; lastSyncAt: Date | null; lastError: string | null;
}

function toRow(r: any): IntegrationRow {
  return {
    id: r.id, orgId: r.org_id, kind: r.kind, status: r.status, settings: r.settings || {},
    credentials: r.credentials_enc ? JSON.parse(decrypt(r.credentials_enc)) : {}, lastSyncAt: r.last_sync_at, lastError: r.last_error,
  };
}

export async function getIntegration(orgId: string, kind: string): Promise<IntegrationRow | null> {
  const r = await one("SELECT * FROM integrations WHERE org_id = $1 AND kind = $2", [orgId, kind]);
  return r ? toRow(r) : null;
}

/** Safe listing for the UI: never returns secrets, only which secret fields are set. */
export async function listIntegrations(orgId: string): Promise<Array<{ kind: string; label: string; status: string; settings: Record<string, any>; secretsSet: string[]; lastSyncAt: Date | null; lastError: string | null }>> {
  const rows = await q("SELECT * FROM integrations WHERE org_id = $1 ORDER BY kind", [orgId]);
  return rows.map((r) => {
    const row = toRow(r);
    const spec = specOf(row.kind);
    return {
      kind: row.kind, label: spec?.label || row.kind, status: row.status, settings: row.settings,
      secretsSet: Object.keys(row.credentials).filter((k) => !!row.credentials[k]),
      lastSyncAt: row.lastSyncAt, lastError: row.lastError,
    };
  });
}

export const saveIntegrationSchema = z.object({
  credentials: z.record(z.string(), z.string().max(4000)).default({}),
  settings: z.record(z.string(), z.any()).default({}),
});

/**
 * Create or update an integration. A blank credential field keeps the stored value, so the UI
 * can save settings without re-typing secrets. Returns a fresh inbound key the first time a
 * push-style lead source is connected (shown once).
 */
export async function saveIntegration(orgId: string, kind: string, input: z.infer<typeof saveIntegrationSchema>): Promise<{ inboundKey: string | null }> {
  const spec = specOf(kind);
  if (!spec) throw badRequest(`Unknown integration "${kind}".`);
  const cur = await getIntegration(orgId, kind);
  const credentials: Record<string, string> = { ...(cur?.credentials || {}) };
  for (const [k, v] of Object.entries(input.credentials)) if (v.trim()) credentials[k] = v.trim();
  const missing = spec.credentialFields.filter((f) => f.required && !credentials[f.key]).map((f) => f.label);
  const settings = { ...(cur?.settings || {}), ...input.settings };
  missing.push(...(spec.settingFields || []).filter((f) => f.required && !String(settings[f.key] ?? "").trim()).map((f) => f.label));
  if (missing.length) throw badRequest(`Missing: ${missing.join(", ")}.`);
  let inboundKey: string | null = null;
  let inboundHash: string | null = null;
  if (spec.inbound) {
    const existing = await one("SELECT inbound_key_hash FROM integrations WHERE org_id = $1 AND kind = $2", [orgId, kind]);
    if (!existing?.inbound_key_hash) { inboundKey = newSecret(24); inboundHash = hashSecret(inboundKey); }
  }
  await q(
    `INSERT INTO integrations (org_id, kind, status, credentials_enc, settings, inbound_key_hash)
     VALUES ($1, $2, 'connected', $3, $4, $5)
     ON CONFLICT (org_id, kind) DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc, settings = EXCLUDED.settings,
       status = 'connected', last_error = NULL, updated_at = now(),
       inbound_key_hash = COALESCE(integrations.inbound_key_hash, EXCLUDED.inbound_key_hash)`,
    [orgId, kind, Object.keys(credentials).length ? encrypt(JSON.stringify(credentials)) : null, JSON.stringify(settings), inboundHash]
  );
  return { inboundKey };
}

export async function deleteIntegration(orgId: string, kind: string): Promise<void> {
  const r = await q("DELETE FROM integrations WHERE org_id = $1 AND kind = $2 RETURNING id", [orgId, kind]);
  if (!r.length) throw notFound("Integration not found.");
}

/** Issue a new inbound key (the old one stops working at once). */
export async function rotateInboundKey(orgId: string, kind: string): Promise<string> {
  const key = newSecret(24);
  const r = await q("UPDATE integrations SET inbound_key_hash = $3, updated_at = now() WHERE org_id = $1 AND kind = $2 RETURNING id", [orgId, kind, hashSecret(key)]);
  if (!r.length) throw notFound("Integration not found.");
  return key;
}

/** Resolve a push-style lead source by its inbound key. */
export async function integrationByInboundKey(kind: string, key: string): Promise<IntegrationRow | null> {
  if (!key) return null;
  const r = await one("SELECT * FROM integrations WHERE kind = $1 AND inbound_key_hash = $2 AND status <> 'disabled'", [kind, hashSecret(key)]);
  return r ? toRow(r) : null;
}

export async function markIntegration(orgId: string, kind: string, ok: boolean, error?: string): Promise<void> {
  await q(
    "UPDATE integrations SET status = $3, last_error = $4, last_sync_at = CASE WHEN $3 = 'connected' THEN now() ELSE last_sync_at END, updated_at = now() WHERE org_id = $1 AND kind = $2",
    [orgId, kind, ok ? "connected" : "error", ok ? null : String(error || "").slice(0, 500)]
  );
}

/** Build the context a connector runs with. `http` is injectable for tests. */
export async function connectorContext(org: Org, kind: string, http: HttpFn = fetchHttp): Promise<{ connector: CrmConnector; ctx: ConnectorContext }> {
  const connector = CRM_CONNECTORS[kind] || native;
  const row = kind === "native" ? null : await getIntegration(org.id, kind);
  if (kind !== "native" && !row) throw badRequest(`${connector.label} is selected as the schedule system but is not connected.`);
  const credentials = { ...(row?.credentials || {}) };
  const ctx: ConnectorContext = {
    org, credentials, settings: row?.settings || {}, http,
    cache: cacheFor(`${org.id}:${kind}`),
    saveCredentials: async (patch) => {
      const merged = { ...credentials, ...patch };
      Object.assign(credentials, patch);
      await q("UPDATE integrations SET credentials_enc = $3, updated_at = now() WHERE org_id = $1 AND kind = $2", [org.id, kind, encrypt(JSON.stringify(merged))]);
    },
  };
  return { connector, ctx };
}
