-- Every knowledge source added from Pine is recorded here (like the CRM keeps an agent's knowledge
-- base in its own database): who added it, for which agent, and when it was deleted. The content
-- itself lives at the voice provider; deleting archives it there and detaches it from every agent.
CREATE TABLE knowledge_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_source_id text NOT NULL,
  agent_id           uuid REFERENCES agents(id) ON DELETE SET NULL,
  scope              text NOT NULL CHECK (scope IN ('workspace', 'agent')),
  kind               text NOT NULL,
  name               text NOT NULL,
  url                text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (org_id, provider_source_id)
);
