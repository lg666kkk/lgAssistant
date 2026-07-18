-- Atomic dual-write for trusted memory.
-- 长期层(agent_memories) 与 语义层(agent_semantic_memories) 在同一个 Postgres 里，
-- 用一个 plpgsql 函数把两次写包进单个事务：任一失败整体回滚，两层永不漂移。
-- 取代应用层 Promise.all([longTerm.set, semantic.set]) 的非原子双写。

-- 幂等 upsert：同一 (user_id, key) 覆盖，两表一起写/一起回滚。
CREATE OR REPLACE FUNCTION upsert_memory(
  p_user_id UUID,
  p_key TEXT,
  p_content TEXT,
  p_embedding VECTOR(1024),
  p_metadata JSONB,
  p_memory_type TEXT,
  p_source TEXT,
  p_confidence DOUBLE PRECISION,
  p_importance DOUBLE PRECISION,
  p_status TEXT,
  p_evidence JSONB,
  p_valid_from TIMESTAMPTZ,
  p_valid_to TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- 长期层：无向量，按业务 key 取
  INSERT INTO agent_memories (
    user_id, key, layer, memory_type, source, confidence, importance, status,
    content, evidence, metadata, valid_from, valid_to, updated_at
  ) VALUES (
    p_user_id, p_key, 'longterm', p_memory_type, p_source, p_confidence, p_importance, p_status,
    p_content, p_evidence, p_metadata, p_valid_from, p_valid_to, NOW()
  )
  ON CONFLICT (user_id, key) DO UPDATE SET
    memory_type = EXCLUDED.memory_type,
    source = EXCLUDED.source,
    confidence = EXCLUDED.confidence,
    importance = EXCLUDED.importance,
    status = EXCLUDED.status,
    content = EXCLUDED.content,
    evidence = EXCLUDED.evidence,
    metadata = EXCLUDED.metadata,
    valid_from = EXCLUDED.valid_from,
    valid_to = EXCLUDED.valid_to,
    updated_at = NOW();

  -- 语义层：带向量，按语义召回
  INSERT INTO agent_semantic_memories (
    user_id, key, layer, memory_type, source, confidence, importance, status,
    content, embedding, evidence, metadata, valid_from, valid_to, updated_at
  ) VALUES (
    p_user_id, p_key, 'semantic', p_memory_type, p_source, p_confidence, p_importance, p_status,
    p_content, p_embedding, p_evidence, p_metadata, p_valid_from, p_valid_to, NOW()
  )
  ON CONFLICT (user_id, key) DO UPDATE SET
    memory_type = EXCLUDED.memory_type,
    source = EXCLUDED.source,
    confidence = EXCLUDED.confidence,
    importance = EXCLUDED.importance,
    status = EXCLUDED.status,
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    evidence = EXCLUDED.evidence,
    metadata = EXCLUDED.metadata,
    valid_from = EXCLUDED.valid_from,
    valid_to = EXCLUDED.valid_to,
    updated_at = NOW();
END;
$$;

COMMENT ON FUNCTION upsert_memory(
  UUID, TEXT, TEXT, VECTOR(1024), JSONB, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ
) IS 'Atomic upsert of a memory into both the long-term and semantic tables in one transaction.';

-- 软失效：两表一起从 active → invalidated，一起回滚。
CREATE OR REPLACE FUNCTION invalidate_memory(
  p_user_id UUID,
  p_key TEXT,
  p_valid_to TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agent_memories
    SET status = 'invalidated', valid_to = p_valid_to, updated_at = NOW()
    WHERE user_id = p_user_id AND key = p_key AND status = 'active';

  UPDATE agent_semantic_memories
    SET status = 'invalidated', valid_to = p_valid_to, updated_at = NOW()
    WHERE user_id = p_user_id AND key = p_key AND status = 'active';
END;
$$;

COMMENT ON FUNCTION invalidate_memory(UUID, TEXT, TIMESTAMPTZ)
IS 'Atomic soft-invalidation of a memory across both the long-term and semantic tables.';
