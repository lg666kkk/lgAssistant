CREATE TABLE IF NOT EXISTS agent_context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS agent_context_snapshots_user_updated_idx
ON agent_context_snapshots (user_id, updated_at DESC);

ALTER TABLE agent_context_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_context_snapshots_owner_policy ON agent_context_snapshots;
CREATE POLICY agent_context_snapshots_owner_policy
ON agent_context_snapshots
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
