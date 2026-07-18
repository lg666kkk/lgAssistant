-- Trusted memory lifecycle: provenance, confidence, temporal validity and soft invalidation.

ALTER TABLE agent_memories
  ADD COLUMN IF NOT EXISTS memory_type TEXT NOT NULL DEFAULT 'fact',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inferred',
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence JSONB,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

ALTER TABLE agent_semantic_memories
  ADD COLUMN IF NOT EXISTS memory_type TEXT NOT NULL DEFAULT 'fact',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inferred',
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence JSONB,
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_confidence_check') THEN
    ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_confidence_check CHECK (confidence BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_importance_check') THEN
    ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_importance_check CHECK (importance BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memories_status_check') THEN
    ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_status_check CHECK (status IN ('active', 'invalidated', 'conflicted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_semantic_memories_confidence_check') THEN
    ALTER TABLE agent_semantic_memories ADD CONSTRAINT agent_semantic_memories_confidence_check CHECK (confidence BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_semantic_memories_importance_check') THEN
    ALTER TABLE agent_semantic_memories ADD CONSTRAINT agent_semantic_memories_importance_check CHECK (importance BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_semantic_memories_status_check') THEN
    ALTER TABLE agent_semantic_memories ADD CONSTRAINT agent_semantic_memories_status_check CHECK (status IN ('active', 'invalidated', 'conflicted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_memories_user_status_idx
ON agent_memories (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS agent_semantic_memories_user_status_idx
ON agent_semantic_memories (user_id, status, updated_at DESC);

DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT);
DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT, UUID);

CREATE FUNCTION match_memories(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 5,
  filter_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  key TEXT,
  layer TEXT,
  memory_type TEXT,
  source TEXT,
  confidence DOUBLE PRECISION,
  importance DOUBLE PRECISION,
  status TEXT,
  content TEXT,
  evidence JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.key, m.layer, m.memory_type, m.source, m.confidence, m.importance,
    m.status, m.content, m.evidence, m.metadata, m.created_at, m.updated_at,
    m.valid_from, m.valid_to, m.last_accessed_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM agent_semantic_memories m
  WHERE filter_user_id IS NOT NULL
    AND m.user_id = filter_user_id
    AND m.status = 'active'
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_memories(VECTOR(1024), FLOAT, INT, UUID)
IS 'Only recalls active semantic memories for an explicit user id.';
