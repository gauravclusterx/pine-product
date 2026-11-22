-- Who is on a call. The voice provider never returns the customer's number on a call record, so
-- (like the CRM's VoiceCallHint) we remember it wherever a call id meets a number: when we dial,
-- and from a campaign's recipient list (each attempt carries the call id). Ingest reads it.
CREATE TABLE call_hints (
  org_id           uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_call_id text NOT NULL,
  phone_e164       text NOT NULL,
  customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider_call_id)
);
