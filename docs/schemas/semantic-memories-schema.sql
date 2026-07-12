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
  content TEXT NOT NULL,                       -- 记忆正文（也是被 embedding 的文本）
  embedding VECTOR(1024) NOT NULL,             -- 1024 维：对齐 lib/knowledge/embedding.ts 的 text-embedding-v4
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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

-- ============================================
-- 向量召回函数：给一个 query 向量，返回最相似的 N 条记忆
-- 照抄 match_documents，去掉 JOIN（语义记忆是自包含的，不像 documents 要关联 pages）
-- ============================================
DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT);

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
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
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
    m.content,
    m.metadata,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity  -- 余弦相似度：越大越像
  FROM agent_semantic_memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_user_id IS NULL OR m.user_id = filter_user_id)
  ORDER BY m.embedding <=> query_embedding              -- 距离升序 = 最像的在前
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_memories(VECTOR(1024), FLOAT, INT, UUID) IS '语义记忆向量召回函数';
