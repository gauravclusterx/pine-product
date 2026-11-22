-- CRM like the ClusterOS CRM: leads and customers are separate lists, every contact has an editable
-- status and tags, and each contact has one conversation (voice calls + SMS). AI keys can be set by
-- platform admins (platform-wide and per customer), stored encrypted.

-- A contact is a lead until a job is booked (or someone marks them a customer).
ALTER TABLE customers
  ADD COLUMN stage         text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'customer')),
  ADD COLUMN status        text NOT NULL DEFAULT 'fresh',
  -- A manual status edit locks it: call analysis never overwrites what a person set.
  ADD COLUMN status_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN tags          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN source        text NOT NULL DEFAULT '';

UPDATE customers c SET stage = 'customer' WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.status <> 'cancelled');
UPDATE customers c SET status = COALESCE((SELECT x.outcome FROM calls x WHERE x.customer_id = c.id AND x.outcome IS NOT NULL ORDER BY x.started_at DESC LIMIT 1), 'fresh');
UPDATE customers c SET source = COALESCE((SELECT l.source FROM leads l WHERE l.customer_id = c.id ORDER BY l.received_at LIMIT 1), '');
CREATE INDEX customers_org_stage ON customers (org_id, stage, updated_at DESC);

-- A booked job makes the contact a customer.
CREATE FUNCTION mark_customer_on_booking() RETURNS trigger AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NEW.status <> 'cancelled' THEN
    UPDATE customers SET stage = 'customer', updated_at = now() WHERE id = NEW.customer_id AND stage <> 'customer';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bookings_mark_customer AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION mark_customer_on_booking();

-- Text messages with a contact (SMS today), both directions, for the conversation view.
CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  phone_e164  text NOT NULL,
  channel     text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  -- who wrote an outbound message: the AI agent, a person in the app, or the system (confirmations)
  author      text NOT NULL DEFAULT 'system' CHECK (author IN ('agent', 'human', 'system', 'customer')),
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'received')),
  provider_id text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_customer ON messages (org_id, customer_id, created_at DESC);
CREATE INDEX messages_phone ON messages (org_id, phone_e164, created_at DESC);

-- AI keys (encrypted) + model, like the CRM admin's "AI keys": platform-wide, and per customer.
ALTER TABLE app_settings
  ADD COLUMN openai_key_enc text, ADD COLUMN openai_model text NOT NULL DEFAULT 'gpt-4o-mini',
  ADD COLUMN anthropic_key_enc text, ADD COLUMN anthropic_model text NOT NULL DEFAULT 'claude-opus-5-5';
ALTER TABLE orgs
  ADD COLUMN openai_key_enc text, ADD COLUMN openai_model text,
  ADD COLUMN anthropic_key_enc text, ADD COLUMN anthropic_model text;
