-- ============================================
-- 分层记忆 - 语义记忆表（能力2）
-- 一行 = 一条可按「语义相似度」召回的记忆（历史问答、知识点等）
-- 对应接口：lib/agent/memory/types.ts 的 SemanticMemoryStore.recall
-- 模式照抄成熟范例：docs/schemas/database-schema-clean.sql 的 documents + match_documents
-- ============================================

-- 启用 pgvector（已启用则跳过）
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_semantic_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 业务 key：set(key)/get(key) 配对用。同一用户内唯一。
  key TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'semantic',
  memory_type TEXT NOT NULL DEFAULT 'fact',
  source TEXT NOT NULL DEFAULT 'inferred',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  content TEXT NOT NULL,                       -- 记忆正文（也是被 embedding 的文本）
  embedding VECTOR(1024) NOT NULL,             -- 1024 维：对齐 lib/knowledge/embedding.ts 的 text-embedding-v4
  evidence JSONB,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  CONSTRAINT agent_semantic_memories_confidence_check CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT agent_semantic_memories_importance_check CHECK (importance BETWEEN 0 AND 1),
  CONSTRAINT agent_semantic_memories_status_check CHECK (status IN ('active', 'invalidated', 'conflicted'))
);

-- 向量相似度索引：HNSW + 余弦距离（vector_cosine_ops 对应查询里的 <=>）
-- 没有它，recall 要和全表逐条算距离（O(n) 暴力）；有了它是近似最近邻（ANN），快几个数量级
CREATE INDEX IF NOT EXISTS agent_semantic_memories_embedding_idx
ON agent_semantic_memories
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

ALTER TABLE agent_semantic_memories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS agent_semantic_memories_user_key_unique_idx ON agent_semantic_memories (user_id, key);
CREATE INDEX IF NOT EXISTS agent_semantic_memories_user_id_layer_idx
ON agent_semantic_memories (user_id, layer);
CREATE INDEX IF NOT EXISTS agent_semantic_memories_created_at_idx
ON agent_semantic_memories (created_at);
CREATE INDEX IF NOT EXISTS agent_semantic_memories_user_status_idx
ON agent_semantic_memories (user_id, status, updated_at DESC);

-- ============================================
-- 向量召回函数：给一个 query 向量，返回最相似的 N 条记忆
-- 照抄 match_documents，去掉 JOIN（语义记忆是自包含的，不像 documents 要关联 pages）
-- ============================================
DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT);
DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT, UUID);

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.3,   -- 阈值比 documents(0.7) 低：记忆召回宁可多召不漏
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
    m.id,
    m.key,
    m.layer,
    m.memory_type,
    m.source,
    m.confidence,
    m.importance,
    m.status,
    m.content,
    m.evidence,
    m.metadata,
    m.created_at,
    m.updated_at,
    m.valid_from,
    m.valid_to,
    m.last_accessed_at,
    1 - (m.embedding <=> query_embedding) AS similarity  -- 余弦相似度：越大越像
  FROM agent_semantic_memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND filter_user_id IS NOT NULL
    AND m.user_id = filter_user_id
    AND m.status = 'active'
  ORDER BY m.embedding <=> query_embedding              -- 距离升序 = 最像的在前
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_memories(VECTOR(1024), FLOAT, INT, UUID) IS '语义记忆向量召回函数';

-- ============================================
-- 原子双写：长期层(agent_memories) + 语义层(agent_semantic_memories) 同事务写入。
-- 应用层不再 Promise.all 两次独立写，避免一成一败导致两层漂移。
-- 详见迁移 migrations/20260718-atomic-memory-write.sql
-- ============================================
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
