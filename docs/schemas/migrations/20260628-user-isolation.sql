-- 登录和用户隔离迁移。
-- 运行前请确保 Supabase Auth 已启用；新数据会由应用写入 user_id。

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE agent_traces ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE compiled_wiki_edges ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE agent_semantic_memories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE leetcode_daily_practices ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE leetcode_wrong_problems ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS sessions_user_id_updated_idx ON sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_user_id_session_idx ON messages (user_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS agent_traces_user_id_created_idx ON agent_traces (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notion_pages_user_id_synced_idx ON notion_pages (user_id, last_synced_at DESC);
CREATE INDEX IF NOT EXISTS documents_user_id_page_idx ON documents (user_id, page_id, chunk_index);
CREATE INDEX IF NOT EXISTS compiled_wiki_pages_user_id_updated_idx ON compiled_wiki_pages (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS compiled_wiki_edges_user_id_from_idx ON compiled_wiki_edges (user_id, from_slug);
CREATE INDEX IF NOT EXISTS agent_memories_user_id_layer_idx ON agent_memories (user_id, layer);
CREATE INDEX IF NOT EXISTS agent_semantic_memories_user_id_layer_idx ON agent_semantic_memories (user_id, layer);
CREATE INDEX IF NOT EXISTS leetcode_daily_practices_user_round_idx ON leetcode_daily_practices (user_id, round_no);
CREATE INDEX IF NOT EXISTS leetcode_wrong_problems_user_review_idx ON leetcode_wrong_problems (user_id, next_review_at);
CREATE INDEX IF NOT EXISTS leetcode_wrong_problems_user_updated_idx ON leetcode_wrong_problems (user_id, updated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compiled_wiki_edges_from_slug_fkey'
      AND conrelid = 'compiled_wiki_edges'::regclass
  ) THEN
    ALTER TABLE compiled_wiki_edges DROP CONSTRAINT compiled_wiki_edges_from_slug_fkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compiled_wiki_pages_slug_key'
      AND conrelid = 'compiled_wiki_pages'::regclass
  ) THEN
    ALTER TABLE compiled_wiki_pages DROP CONSTRAINT compiled_wiki_pages_slug_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compiled_wiki_edges_from_slug_to_label_relation_key'
      AND conrelid = 'compiled_wiki_edges'::regclass
  ) THEN
    ALTER TABLE compiled_wiki_edges DROP CONSTRAINT compiled_wiki_edges_from_slug_to_label_relation_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leetcode_daily_practices_pkey'
      AND conrelid = 'leetcode_daily_practices'::regclass
  ) THEN
    ALTER TABLE leetcode_daily_practices DROP CONSTRAINT leetcode_daily_practices_pkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leetcode_wrong_problems_pkey'
      AND conrelid = 'leetcode_wrong_problems'::regclass
  ) THEN
    ALTER TABLE leetcode_wrong_problems DROP CONSTRAINT leetcode_wrong_problems_pkey;
  END IF;
END $$;

ALTER TABLE leetcode_daily_practices ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE leetcode_wrong_problems ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leetcode_daily_practices_pkey'
      AND conrelid = 'leetcode_daily_practices'::regclass
  ) THEN
    ALTER TABLE leetcode_daily_practices ADD CONSTRAINT leetcode_daily_practices_pkey PRIMARY KEY (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leetcode_wrong_problems_pkey'
      AND conrelid = 'leetcode_wrong_problems'::regclass
  ) THEN
    ALTER TABLE leetcode_wrong_problems ADD CONSTRAINT leetcode_wrong_problems_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS compiled_wiki_pages_user_slug_unique_idx
ON compiled_wiki_pages (user_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS compiled_wiki_edges_user_relation_unique_idx
ON compiled_wiki_edges (user_id, from_slug, to_label, relation);

CREATE UNIQUE INDEX IF NOT EXISTS leetcode_daily_practices_user_date_unique_idx
ON leetcode_daily_practices (user_id, practice_date);

CREATE UNIQUE INDEX IF NOT EXISTS leetcode_wrong_problems_user_problem_unique_idx
ON leetcode_wrong_problems (user_id, problem_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_memories_key_key'
      AND conrelid = 'agent_memories'::regclass
  ) THEN
    ALTER TABLE agent_memories DROP CONSTRAINT agent_memories_key_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_semantic_memories_key_key'
      AND conrelid = 'agent_semantic_memories'::regclass
  ) THEN
    ALTER TABLE agent_semantic_memories DROP CONSTRAINT agent_semantic_memories_key_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_user_key_unique_idx
ON agent_memories (user_id, key);

CREATE UNIQUE INDEX IF NOT EXISTS agent_semantic_memories_user_key_unique_idx
ON agent_semantic_memories (user_id, key);

DROP FUNCTION IF EXISTS match_memories(VECTOR(1024), FLOAT, INT);

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.3,
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
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM agent_semantic_memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_user_id IS NULL OR m.user_id = filter_user_id)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_memories(VECTOR(1024), FLOAT, INT, UUID) IS '语义记忆向量召回函数';

-- RAG 表结构的彻底多租户迁移在 20260628-rag-multitenant.sql。
-- 若需要支持多个用户同步同一个 Notion page_id，请继续执行该迁移。

DROP FUNCTION IF EXISTS match_documents(VECTOR(1024), FLOAT, INT);

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  filter_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  page_id TEXT,
  page_title TEXT,
  page_url TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.page_id,
    p.page_title,
    p.page_url,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  JOIN notion_pages p ON d.page_id = p.page_id
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    AND (filter_user_id IS NULL OR d.user_id = filter_user_id)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents(VECTOR(1024), FLOAT, INT, UUID) IS '向量相似度检索函数';
