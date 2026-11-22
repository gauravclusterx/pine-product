-- Subscription + prepaid credits, the way the Pine AI CRM bills:
--   * a monthly subscription per client (price + currency set by platform staff, a free trial),
--     which can be required before a client uses the app (the "paywall", switched by staff);
--   * a prepaid wallet: voice credits (1 per call-minute, exact seconds, minimum 1 for a connected
--     call) and message credits (1 per message sent to a customer), bought as top-ups at a per-client
--     rate (credits per 1 unit of currency) plus an optional tax on top-ups.

CREATE TABLE app_settings (
  id                          boolean PRIMARY KEY DEFAULT true CHECK (id),
  paywall_enabled             boolean NOT NULL DEFAULT false,
  default_subscription_price  numeric(12,2) NOT NULL DEFAULT 3499,
  default_currency            text NOT NULL DEFAULT 'INR' CHECK (default_currency IN ('INR', 'USD', 'GBP')),
  default_voice_per_unit      numeric(12,4) NOT NULL DEFAULT 0.2,
  default_chat_per_unit       numeric(12,4) NOT NULL DEFAULT 2,
  default_tax_percent         numeric(5,2) NOT NULL DEFAULT 18,
  trial_days                  integer NOT NULL DEFAULT 7 CHECK (trial_days BETWEEN 0 AND 365),
  -- Credits a brand-new client starts with (so a trial can make a few calls).
  starter_voice_credits       numeric(12,2) NOT NULL DEFAULT 0,
  starter_chat_credits        numeric(12,2) NOT NULL DEFAULT 0,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (true);

ALTER TABLE orgs
  ADD COLUMN subscription_status     text NOT NULL DEFAULT 'inactive' CHECK (subscription_status IN ('inactive', 'trial', 'active', 'expired')),
  ADD COLUMN subscription_expires_at timestamptz,
  ADD COLUMN trial_started_at        timestamptz,
  ADD COLUMN trial_ends_at           timestamptz,
  -- NULL = use the platform default.
  ADD COLUMN subscription_price      numeric(12,2) CHECK (subscription_price IS NULL OR subscription_price >= 0),
  ADD COLUMN currency                text CHECK (currency IS NULL OR currency IN ('INR', 'USD', 'GBP')),
  ADD COLUMN voice_per_unit          numeric(12,4) CHECK (voice_per_unit IS NULL OR voice_per_unit > 0),
  ADD COLUMN chat_per_unit           numeric(12,4) CHECK (chat_per_unit IS NULL OR chat_per_unit > 0),
  ADD COLUMN tax_percent             numeric(5,2) CHECK (tax_percent IS NULL OR tax_percent BETWEEN 0 AND 100),
  ADD COLUMN wallet_voice            numeric(14,2) NOT NULL DEFAULT 0 CHECK (wallet_voice >= 0),
  ADD COLUMN wallet_chat             numeric(14,2) NOT NULL DEFAULT 0 CHECK (wallet_chat >= 0),
  ADD COLUMN suspended               boolean NOT NULL DEFAULT false;

-- Clients that existed before billing keep working.
UPDATE orgs SET subscription_status = 'active', subscription_expires_at = now() + interval '30 days';

-- Voice credits taken for a call (compare-and-set: a call is debited once).
ALTER TABLE calls ADD COLUMN billed_credits numeric(10,2);

CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('subscription', 'topup')),
  provider       text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay', 'manual')),
  order_id       text UNIQUE,
  payment_id     text,
  amount_minor   integer NOT NULL CHECK (amount_minor >= 0),
  currency       text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
  voice_credits  numeric(12,2) NOT NULL DEFAULT 0,
  chat_credits   numeric(12,2) NOT NULL DEFAULT 0,
  period_start   timestamptz,
  period_end     timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_org ON payments (org_id, created_at DESC);

-- Every credit movement, for the client's usage history and for audits.
CREATE TABLE wallet_ledger (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('voice', 'chat')),
  delta      numeric(12,2) NOT NULL,
  reason     text NOT NULL,
  ref        text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_org ON wallet_ledger (org_id, created_at DESC);
