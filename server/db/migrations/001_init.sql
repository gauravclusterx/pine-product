-- Pine AI platform — initial schema.
--
-- Tenancy: an ORG is one client business. Every tenant-owned row carries org_id and every
-- query filters on it (enforced in the data layer, tested per module). Platform staff
-- (users.is_platform_admin) can act on any org.
--
-- Scale notes: the hot, ever-growing tables are calls, leads and jobs. Their indexes lead with
-- org_id + time so a tenant's reads never scan another tenant's rows, and they are the first
-- candidates for monthly range partitioning (see docs/ARCHITECTURE.md → "Scaling").

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── identity ──────────────────────────────────────────────────────────────────

CREATE TABLE orgs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  industry      text NOT NULL DEFAULT 'hvac',
  timezone      text NOT NULL DEFAULT 'America/New_York',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'churned')),
  -- Business rules the lead intake and the agents apply.
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the client pays per minute of conversation, in cents (set by platform staff).
  rate_cents_per_minute integer NOT NULL DEFAULT 25 CHECK (rate_cents_per_minute >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  -- Bumped to invalidate every session of the user (password change, forced sign-out).
  token_version integer NOT NULL DEFAULT 0,
  disabled      boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE memberships (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_time ON audit_log (org_id, created_at DESC);

-- ── voice ─────────────────────────────────────────────────────────────────────

-- One voice workspace per org. Secrets are AES-256-GCM encrypted by the application.
CREATE TABLE voice_workspaces (
  org_id               uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  api_key_enc          text NOT NULL,
  workspace_id         text NOT NULL UNIQUE,
  webhook_secret_enc   text,
  webhook_endpoint_id  text,
  -- Secret the agent's tools send back to the Integration Hub (hashed: it is only ever compared).
  tool_secret_hash     text NOT NULL,
  -- The same secret, encrypted, so it can be re-sent to the provider when tools are re-provisioned.
  tool_secret_enc      text NOT NULL,
  connected_at         timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- Which internal playbook the agent was started from (inbound_booking, speed_to_lead, …).
  playbook          text NOT NULL DEFAULT 'custom',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  -- The agent as designed here: prompt, greeting, voice, language, limits, transfer rules,
  -- extraction fields, enabled tools. This is the source of truth; the provider is a projection.
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_agent_id text UNIQUE,
  live_version_id   text,
  published_at      timestamptz,
  publish_error     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX agents_org ON agents (org_id, status);

CREATE TABLE phone_numbers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_number_id text NOT NULL,
  e164               text NOT NULL,
  label              text NOT NULL DEFAULT '',
  supports_inbound   boolean NOT NULL DEFAULT true,
  supports_outbound  boolean NOT NULL DEFAULT true,
  inbound_agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  inbound_setup      text,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider_number_id)
);

-- ── customers, leads ──────────────────────────────────────────────────────────

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT '',
  phone_e164  text NOT NULL,
  email       text NOT NULL DEFAULT '',
  address     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Id of this customer in the client's own system, and which connector owns it.
  external_id text,
  connector   text,
  notes       text NOT NULL DEFAULT '',
  -- Consent to be called (TCPA): when it was given and how it was captured.
  consent_at     timestamptz,
  consent_source text,
  -- Read-through cache of what the connector knows (membership, open estimates), with its age.
  crm_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone_e164)
);
CREATE INDEX customers_org_external ON customers (org_id, connector, external_id);

-- Numbers that must never be dialled for this org (opt-outs, complaints, wrong numbers).
CREATE TABLE dnc_list (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  reason     text NOT NULL DEFAULT 'opt_out',
  source     text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone_e164)
);

CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- google_lsa | meta | yelp | angi | thumbtack | web_form | web_chat | email | manual | api
  source       text NOT NULL,
  -- The lead's id at the source. (org, source, source_ref) is unique: a redelivered webhook or a
  -- re-polled lead never creates a second lead or a second call.
  source_ref   text NOT NULL,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  name         text NOT NULL DEFAULT '',
  phone_e164   text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  service      text NOT NULL DEFAULT '',
  postal_code  text NOT NULL DEFAULT '',
  message      text NOT NULL DEFAULT '',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- new → queued → calling → contacted | booked | lost ; rejected = failed the intake rules
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'queued', 'calling', 'contacted', 'booked', 'lost', 'rejected')),
  reject_reason text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  first_call_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, source_ref)
);
CREATE INDEX leads_org_time ON leads (org_id, received_at DESC);
CREATE INDEX leads_org_status ON leads (org_id, status, received_at DESC);

-- ── calls ─────────────────────────────────────────────────────────────────────

CREATE TABLE campaigns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  -- estimate_followup | membership_renewal | reactivation | after_job | reminder | custom
  kind                 text NOT NULL DEFAULT 'custom',
  agent_id             uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  provider_campaign_id text,
  -- Calling window: { timezone, opensMinute, closesMinute, startAt, endAt }
  calling_window       jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_count      integer NOT NULL DEFAULT 0,
  skipped              jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error           text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org ON campaigns (org_id, created_at DESC);

CREATE TABLE campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone_e164  text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  variables   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (campaign_id, phone_e164)
);

CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_call_id text NOT NULL,
  agent_id         uuid REFERENCES agents(id) ON DELETE SET NULL,
  direction        text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound', 'web')),
  customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  phone_e164       text NOT NULL DEFAULT '',
  -- queued | in-progress | ended
  status           text NOT NULL DEFAULT 'queued',
  -- busy | no_answer | voicemail | agent_hangup | customer_hangup | … (see voice/rasen/mappers.ts)
  ended_reason     text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  -- Seconds of conversation, and the seconds billed (metered by the provider when available).
  duration_seconds integer NOT NULL DEFAULT 0,
  billable_seconds integer NOT NULL DEFAULT 0,
  -- What the client is charged for this call, in cents. Written once (see calls service).
  charge_cents     integer,
  transcript       jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary          text NOT NULL DEFAULT '',
  extraction       jsonb NOT NULL DEFAULT '{}'::jsonb,
  recording_available boolean NOT NULL DEFAULT false,
  -- booked | callback | quote | info | not_interested | no_contact | transferred | opt_out | unknown
  outcome          text,
  qa_score         integer CHECK (qa_score IS NULL OR (qa_score >= 0 AND qa_score <= 100)),
  qa               jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_updated_at timestamptz,
  results_final    boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider_call_id)
);
CREATE INDEX calls_org_time ON calls (org_id, started_at DESC);
CREATE INDEX calls_org_agent_time ON calls (org_id, agent_id, started_at DESC);
CREATE INDEX calls_org_customer ON calls (org_id, customer_id, started_at DESC);
CREATE INDEX calls_org_outcome ON calls (org_id, outcome, started_at DESC);
CREATE INDEX calls_campaign ON calls (campaign_id) WHERE campaign_id IS NOT NULL;

-- Jobs the agents booked (or tried to) in the client's system of record.
CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  connector       text NOT NULL,
  external_job_id text,
  job_type        text NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'rescheduled', 'cancelled', 'completed')),
  -- Expected revenue of the job in cents (from the client's price book), for the dashboard.
  value_cents     integer NOT NULL DEFAULT 0,
  -- Makes a retried tool call create the job once (the agent's tool may be retried by a human redial).
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX bookings_org_time ON bookings (org_id, starts_at);
-- Slot capacity for the built-in calendar is enforced in hub/native.ts under an advisory lock.
CREATE INDEX bookings_org_slot ON bookings (org_id, starts_at) WHERE status IN ('booked', 'rescheduled');

-- The caller's number of an inbound call reaches us only through the agent's before-call tool,
-- which carries no call id. It is recorded here and matched to the call afterwards.
CREATE TABLE inbound_lookups (
  id                bigserial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_agent_id text NOT NULL,
  phone_e164        text NOT NULL,
  provider_call_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_lookups_match ON inbound_lookups (org_id, provider_agent_id, created_at DESC);

-- ── integrations ──────────────────────────────────────────────────────────────

CREATE TABLE integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- servicetitan | housecall_pro | jobber | salesforce | acculynx | generic_rest | native
  -- twilio | slack | google_calendar | outlook | google_lsa | meta | yelp | angi | thumbtack | email_parse
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disabled')),
  credentials_enc text,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Random per-integration key that authenticates inbound webhooks of this source.
  inbound_key_hash text,
  last_sync_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);
CREATE INDEX integrations_inbound_key ON integrations (inbound_key_hash) WHERE inbound_key_hash IS NOT NULL;

-- ── platform plumbing ─────────────────────────────────────────────────────────

-- Every webhook we accepted, by the sender's event id. The primary key is the dedupe.
CREATE TABLE webhook_deliveries (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  event_type  text NOT NULL DEFAULT '',
  org_id      uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX webhook_deliveries_time ON webhook_deliveries (received_at);

-- Durable job queue. Workers claim rows with FOR UPDATE SKIP LOCKED, so any number of worker
-- processes can run side by side without a broker and without ever taking the same job twice.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  queue        text NOT NULL,
  org_id       uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  -- At most one live job per key: enqueueing the same work twice is a no-op.
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_ready ON jobs (queue, run_at) WHERE status = 'queued';
CREATE INDEX jobs_running ON jobs (locked_at) WHERE status = 'running';
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Sliding-window counters used to stay under the voice provider's per-key rate limits across
-- every process (call starts are 10 per minute per key).
CREATE TABLE rate_events (
  bucket     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_events_bucket ON rate_events (bucket, at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
