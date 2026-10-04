-- ============================================
-- RAG 知识库数据库设计（优化版）
-- 针对需求：更新检测 + 问答式检索
-- ============================================

-- 1. 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 创建 notion_pages 表（用于更新检测）
CREATE TABLE IF NOT EXISTS notion_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  page_title TEXT NOT NULL,
  page_url TEXT NOT NULL,
  last_edited_time TIMESTAMPTZ NOT NULL,  -- Notion 的 last_edited_time
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  chunk_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

COMMENT ON TABLE notion_pages IS 'Notion 页面元数据，用于更新检测';
COMMENT ON COLUMN notion_pages.last_edited_time IS 'Notion API 返回的最后编辑时间';
COMMENT ON COLUMN notion_pages.last_synced_at IS '最后同步时间';
COMMENT ON COLUMN notion_pages.metadata IS '页面级元数据：content_hash、embedding_model、chunker_version 等';

-- 3. 创建 documents 表（存储 chunk 和向量）
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  notion_page_id UUID REFERENCES notion_pages(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 兼容已存在的旧表：CREATE TABLE IF NOT EXISTS 不会自动补字段
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
-- 知识源类型（notion / document）；Storage bucket 与 rag_ingestion_jobs.source_type
-- 生成列见 migrations/20261002-rag-file-sources.sql
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'notion';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS notion_page_id UUID REFERENCES notion_pages(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

COMMENT ON TABLE documents IS 'RAG 知识库文档 chunk 表';
COMMENT ON COLUMN documents.notion_page_id IS 'notion_pages.id 外键，真正用于多用户隔离和级联删除';
COMMENT ON COLUMN documents.page_id IS 'Notion 原始页面 ID（冗余字段，便于展示和兼容脚本）';
COMMENT ON COLUMN documents.chunk_index IS 'chunk 在页面中的序号（从 0 开始）';
COMMENT ON COLUMN documents.metadata IS 'chunk 元数据：page_title、page_url、heading_path、start_char、end_char、content_hash、embedding_model、chunker_version、last_edited_time';

-- 4. 创建索引
-- 向量相似度索引（HNSW 算法，余弦距离）
CREATE INDEX IF NOT EXISTS documents_embedding_idx
ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- notion_page_id/page_id 索引（用于按页面删除和查询）
CREATE INDEX IF NOT EXISTS documents_notion_page_id_idx ON documents (notion_page_id);
CREATE INDEX IF NOT EXISTS documents_page_id_idx ON documents (page_id);

-- 全文搜索索引（用于混合检索的关键词召回）
CREATE INDEX IF NOT EXISTS documents_search_vector_idx
ON documents
USING gin (search_vector);

-- 唯一约束：同一页面的同一 chunk_index 只能存在一次
CREATE UNIQUE INDEX IF NOT EXISTS documents_page_chunk_unique_idx
ON documents (notion_page_id, chunk_index);

-- notion_pages 的 last_edited_time 索引（用于查找需要更新的页面）
CREATE INDEX IF NOT EXISTS notion_pages_last_edited_idx
ON notion_pages (last_edited_time);

CREATE UNIQUE INDEX IF NOT EXISTS notion_pages_user_page_unique_idx
ON notion_pages (user_id, page_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notion_pages_source_type_check'
      AND conrelid = 'notion_pages'::regclass
  ) THEN
    ALTER TABLE notion_pages
      ADD CONSTRAINT notion_pages_source_type_check
      CHECK (source_type IN ('notion', 'document'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notion_pages_user_source_idx
ON notion_pages (user_id, source_type, last_synced_at DESC);

COMMENT ON COLUMN notion_pages.source_type IS '知识源类型：notion 页面或 document（用户上传文件）';

-- 4.1 用户上传文件元数据；索引中的 page_id 为 file:<knowledge_files.id>
CREATE TABLE IF NOT EXISTS knowledge_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('markdown', 'text', 'html', 'pdf', 'docx')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, sha256)
);

CREATE INDEX IF NOT EXISTS knowledge_files_user_created_idx
ON knowledge_files (user_id, created_at DESC);

ALTER TABLE knowledge_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "用户只能读取自己的知识库文件" ON knowledge_files;
CREATE POLICY "用户只能读取自己的知识库文件"
  ON knowledge_files FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE knowledge_files IS '用户上传到 RAG 知识库的原始文件元数据';

-- 5. 原子同步页面元数据和 chunks
CREATE OR REPLACE FUNCTION sync_notion_page_documents_atomic(
  p_user_id UUID,
  p_page_id TEXT,
  p_page_title TEXT,
  p_page_url TEXT,
  p_last_edited_time TIMESTAMPTZ,
  p_page_metadata JSONB,
  p_documents JSONB
)
RETURNS TABLE (
  page_row_id UUID,
  inserted_count INTEGER
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_page_row_id UUID;
  v_inserted_count INTEGER;
  v_document JSONB;
  v_source_type TEXT := COALESCE(p_page_metadata->>'source_type', 'notion');
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF btrim(p_page_id) = '' THEN
    RAISE EXCEPTION 'p_page_id is required';
  END IF;
  IF jsonb_typeof(p_documents) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_documents must be a JSON array';
  END IF;
  IF jsonb_array_length(p_documents) = 0 THEN
    RAISE EXCEPTION 'p_documents must not be empty';
  END IF;
  IF v_source_type NOT IN ('notion', 'document') THEN
    RAISE EXCEPTION 'invalid source_type: %', v_source_type;
  END IF;

  FOR v_document IN SELECT value FROM jsonb_array_elements(p_documents)
  LOOP
    IF jsonb_typeof(v_document->'chunk_index') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v_document->'content') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_document->'embedding') IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'invalid document payload';
    END IF;
    IF jsonb_array_length(v_document->'embedding') <> 1024 THEN
      RAISE EXCEPTION 'document embedding must contain 1024 values';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || p_page_id, 0)
  );

  -- 与 delete_knowledge_file_atomic 共用锁：迟到的 worker 不得恢复已删除文件。
  IF v_source_type = 'document' THEN
    IF p_page_id NOT LIKE 'file:%' OR NOT EXISTS (
      SELECT 1 FROM knowledge_files
      WHERE user_id = p_user_id
        AND id = substring(p_page_id FROM 6)::UUID
    ) THEN
      RAISE EXCEPTION 'knowledge file no longer exists' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO notion_pages (
    user_id, page_id, page_title, page_url, last_edited_time,
    last_synced_at, chunk_count, metadata, source_type
  )
  VALUES (
    p_user_id, p_page_id, p_page_title, p_page_url, p_last_edited_time,
    NOW(), jsonb_array_length(p_documents), COALESCE(p_page_metadata, '{}'::JSONB),
    v_source_type
  )
  ON CONFLICT (user_id, page_id)
  DO UPDATE SET
    page_title = EXCLUDED.page_title,
    page_url = EXCLUDED.page_url,
    last_edited_time = EXCLUDED.last_edited_time,
    last_synced_at = EXCLUDED.last_synced_at,
    chunk_count = EXCLUDED.chunk_count,
    metadata = EXCLUDED.metadata,
    source_type = EXCLUDED.source_type
  RETURNING id INTO v_page_row_id;

  DELETE FROM documents
  WHERE notion_page_id = v_page_row_id
    AND user_id = p_user_id;

  INSERT INTO documents (
    user_id, notion_page_id, page_id, chunk_index, content, embedding, metadata
  )
  SELECT
    p_user_id,
    v_page_row_id,
    p_page_id,
    (item.value->>'chunk_index')::INTEGER,
    item.value->>'content',
    (item.value->>'embedding')::VECTOR(1024),
    COALESCE(item.value->'metadata', '{}'::JSONB)
  FROM jsonb_array_elements(p_documents) AS item(value);

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
  IF v_inserted_count <> jsonb_array_length(p_documents) THEN
    RAISE EXCEPTION 'inserted document count mismatch: %/%',
      v_inserted_count,
      jsonb_array_length(p_documents);
  END IF;

  RETURN QUERY SELECT v_page_row_id, v_inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION sync_notion_page_documents_atomic(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sync_notion_page_documents_atomic(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, JSONB
) TO service_role;

COMMENT ON FUNCTION sync_notion_page_documents_atomic(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB, JSONB
) IS 'Atomically upserts one knowledge source (notion page or uploaded document) and replaces all of its RAG document chunks';

-- 5.1 原子删除上传文件：与发布共用事务锁，返回待清理的 Storage 路径
CREATE OR REPLACE FUNCTION delete_knowledge_file_atomic(
  p_user_id UUID,
  p_file_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_page_id TEXT := 'file:' || p_file_id::TEXT;
  v_storage_path TEXT;
BEGIN
  IF p_user_id IS NULL OR p_file_id IS NULL THEN
    RAISE EXCEPTION 'user_id and file_id are required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || v_page_id, 0)
  );

  SELECT storage_path INTO v_storage_path
  FROM knowledge_files
  WHERE user_id = p_user_id AND id = p_file_id;

  -- rag_ingestion_jobs 定义见 migrations/20260717-rag-ingestion-production.sql
  UPDATE rag_ingestion_jobs
  SET status = 'cancelled', lease_until = NULL, updated_at = NOW()
  WHERE user_id = p_user_id AND page_id = v_page_id
    AND status IN ('queued', 'retry_wait', 'running');

  DELETE FROM notion_pages
  WHERE user_id = p_user_id AND page_id = v_page_id;

  DELETE FROM knowledge_files
  WHERE user_id = p_user_id AND id = p_file_id;

  RETURN v_storage_path;
END;
$$;

REVOKE ALL ON FUNCTION delete_knowledge_file_atomic(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_knowledge_file_atomic(UUID, UUID) TO service_role;

-- 6. 创建向量相似度检索 RPC 函数
-- 清掉旧版 3 参数函数，避免 Postgres 同名重载导致 COMMENT/RPC 歧义。
DROP FUNCTION IF EXISTS match_documents(VECTOR(1024), FLOAT, INT);
DROP FUNCTION IF EXISTS match_documents(VECTOR(1024), FLOAT, INT, UUID);

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
  embedding_text TEXT,
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
    d.embedding::TEXT AS embedding_text,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  JOIN notion_pages p ON d.notion_page_id = p.id
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    AND (filter_user_id IS NULL OR p.user_id = filter_user_id)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents(VECTOR(1024), FLOAT, INT, UUID) IS '向量相似度检索函数';

-- 7. 创建关键词检索 RPC 函数（用于 vector + keyword 混合检索）
DROP FUNCTION IF EXISTS match_documents_keyword(TEXT, INT, UUID);

CREATE OR REPLACE FUNCTION match_documents_keyword(
  query_text TEXT,
  match_count INT DEFAULT 20,
  filter_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  page_id TEXT,
  page_title TEXT,
  page_url TEXT,
  content TEXT,
  metadata JSONB,
  embedding_text TEXT,
  keyword_rank FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  parsed_query TSQUERY;
BEGIN
  IF btrim(query_text) = '' THEN
    RETURN;
  END IF;

  parsed_query := websearch_to_tsquery('simple', query_text);

  RETURN QUERY
  WITH terms AS (
    SELECT DISTINCT term
    FROM regexp_split_to_table(lower(query_text), '\s+') AS term
    WHERE length(term) > 0
  ),
  term_count AS (
    SELECT GREATEST(COUNT(*)::FLOAT, 1) AS value
    FROM terms
  ),
  scored AS (
    SELECT
      d.id,
      p.page_id,
      p.page_title,
      p.page_url,
      d.content,
      d.metadata,
      d.embedding::TEXT AS embedding_text,
      ts_rank_cd(d.search_vector, parsed_query) AS fts_rank,
      CASE
        WHEN lower(d.content) LIKE '%' || lower(query_text) || '%'
          OR lower(p.page_title) LIKE '%' || lower(query_text) || '%'
        THEN 1.0
        ELSE 0.0
      END AS exact_rank,
      (
        SELECT COUNT(*)::FLOAT
        FROM terms t
        WHERE lower(d.content || ' ' || p.page_title) LIKE '%' || t.term || '%'
      ) / (SELECT value FROM term_count) AS overlap_rank
    FROM documents d
    JOIN notion_pages p ON d.notion_page_id = p.id
    WHERE (filter_user_id IS NULL OR p.user_id = filter_user_id)
      AND (
        (numnode(parsed_query) > 0 AND d.search_vector @@ parsed_query)
        OR lower(d.content) LIKE '%' || lower(query_text) || '%'
        OR lower(p.page_title) LIKE '%' || lower(query_text) || '%'
        OR EXISTS (
          SELECT 1
          FROM terms t
          WHERE lower(d.content || ' ' || p.page_title) LIKE '%' || t.term || '%'
        )
      )
  )
  SELECT
    scored.id,
    scored.page_id,
    scored.page_title,
    scored.page_url,
    scored.content,
    scored.metadata,
    scored.embedding_text,
    LEAST(
      1.0,
      GREATEST(
        scored.fts_rank / (1.0 + scored.fts_rank),
        scored.exact_rank,
        scored.overlap_rank * 0.7
      )
    ) AS keyword_rank
  FROM scored
  ORDER BY keyword_rank DESC, page_title ASC
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents_keyword(TEXT, INT, UUID) IS 'RAG keyword lexical search function used for hybrid retrieval';

-- 8. 创建检查是否需要更新的函数
CREATE OR REPLACE FUNCTION need_sync_pages()
RETURNS TABLE (
  page_id TEXT,
  page_title TEXT,
  last_edited_time TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.page_id,
    p.page_title,
    p.last_edited_time,
    p.last_synced_at
  FROM notion_pages p
  WHERE p.last_edited_time > p.last_synced_at
  ORDER BY p.last_edited_time DESC;
END;
$$;

COMMENT ON FUNCTION need_sync_pages IS '返回需要同步的页面列表';

-- 9. LLM 编译知识库：wiki 页面和关系边
CREATE TABLE IF NOT EXISTS compiled_wiki_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  concepts TEXT[] NOT NULL DEFAULT '{}',
  source_page_ids TEXT[] NOT NULL DEFAULT '{}',
  source_document_ids UUID[] NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS compiled_wiki_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  from_slug TEXT NOT NULL,
  to_label TEXT NOT NULL,
  relation TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, from_slug, to_label, relation)
);

ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS concepts TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS source_page_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS source_document_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE compiled_wiki_pages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE compiled_wiki_edges ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE compiled_wiki_edges ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS compiled_wiki_pages_user_slug_unique_idx
ON compiled_wiki_pages (user_id, slug);

CREATE INDEX IF NOT EXISTS compiled_wiki_pages_updated_idx
ON compiled_wiki_pages (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS compiled_wiki_pages_concepts_idx
ON compiled_wiki_pages USING gin (concepts);

CREATE INDEX IF NOT EXISTS compiled_wiki_edges_from_slug_idx
ON compiled_wiki_edges (user_id, from_slug);

COMMENT ON TABLE compiled_wiki_pages IS 'LLM 编译后的知识库 wiki 页面';
COMMENT ON TABLE compiled_wiki_edges IS 'LLM 编译知识库页面之间的概念关系';

-- 9. 知识库画像缓存：把 compiled wiki summaries 压缩后的工具描述持久化
CREATE TABLE IF NOT EXISTS knowledge_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_type TEXT NOT NULL DEFAULT 'search_notes_tool',
  source_hash TEXT NOT NULL,
  profile TEXT NOT NULL,
  custom_profile TEXT CHECK (custom_profile IS NULL OR char_length(custom_profile) <= 320),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  custom_updated_at TIMESTAMPTZ,
  UNIQUE (user_id, profile_type)
);

ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS profile_type TEXT NOT NULL DEFAULT 'search_notes_tool';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS source_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS custom_profile TEXT;
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS custom_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_profiles_custom_profile_length_check'
  ) THEN
    ALTER TABLE knowledge_profiles
      ADD CONSTRAINT knowledge_profiles_custom_profile_length_check
      CHECK (custom_profile IS NULL OR char_length(custom_profile) <= 320);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_profiles_user_type_unique_idx
ON knowledge_profiles (user_id, profile_type);

CREATE INDEX IF NOT EXISTS knowledge_profiles_updated_idx
ON knowledge_profiles (user_id, updated_at DESC);

COMMENT ON TABLE knowledge_profiles IS '个人知识库画像缓存，用于工具描述和路由提示';
COMMENT ON COLUMN knowledge_profiles.profile IS '系统根据已编译知识页自动生成的画像';
COMMENT ON COLUMN knowledge_profiles.custom_profile IS '用户自定义覆盖层；非空时优先于系统画像';

-- 用户本人维护的稳定画像：独立于知识库画像与自动长期记忆。
CREATE TABLE IF NOT EXISTS user_agent_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_agent_profiles_content_length CHECK (char_length(content) <= 8000)
);

ALTER TABLE user_agent_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_agent_profiles FROM anon, authenticated;

COMMENT ON TABLE user_agent_profiles IS '用户维护的稳定画像，以 USER.md 风格编辑并注入 Agent Prompt';
COMMENT ON COLUMN user_agent_profiles.content IS 'Markdown 画像正文；脱敏后写入本地 Trace 与 Langfuse';

-- 当前用户的知识库数据源连接。密钥仅通过服务端加密读写。
CREATE TABLE IF NOT EXISTS user_knowledge_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_ciphertext TEXT NOT NULL DEFAULT '',
  credentials_hint TEXT NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_test_status TEXT CHECK (last_test_status IN ('success', 'failed')),
  last_test_error TEXT,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_knowledge_connections_provider_check CHECK (provider IN ('notion')),
  CONSTRAINT user_knowledge_connections_user_provider_unique UNIQUE (user_id, provider)
);

ALTER TABLE user_knowledge_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_knowledge_connections FROM anon, authenticated;

COMMENT ON TABLE user_knowledge_connections IS '当前用户的知识库连接凭据和连接器设置';

-- Chinese lexical retrieval: keep aligned with 20261002-rag-lexical-search.sql.
-- Deploy after 20261002-rag-correctness.sql. Existing rows are indexed automatically.
BEGIN;

-- Same lower-case ASCII tokens / Chinese bigrams as lib/knowledge/lexical.ts.
CREATE OR REPLACE FUNCTION rag_lexical_terms(input_text TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT term ORDER BY term), ARRAY[]::TEXT[])
  FROM (
    SELECT CASE WHEN token ~ '^[一-鿿]+$' AND char_length(token) > 1
      THEN substr(token, position, 2) ELSE token END AS term
    FROM (
      SELECT matches[1] AS token
      FROM regexp_matches(lower(COALESCE(input_text, '')), '[a-z0-9_./:-]+|[一-鿿]+', 'g') AS matches
    ) tokens
    CROSS JOIN LATERAL generate_series(1,
      CASE WHEN token ~ '^[一-鿿]+$' THEN GREATEST(char_length(token) - 1, 1) ELSE 1 END
    ) AS position
  ) terms;
$$;

CREATE OR REPLACE FUNCTION rag_lexical_vector(input_text TEXT, term_weight TEXT DEFAULT 'D')
RETURNS TSVECTOR LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT COALESCE(string_agg(format('%L:%s%s', term, position, term_weight), ' '), '')::tsvector
  FROM unnest(rag_lexical_terms(input_text)) WITH ORDINALITY AS terms(term, position);
$$;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS lexical_vector TSVECTOR
GENERATED ALWAYS AS (
  rag_lexical_vector(COALESCE(metadata->>'page_title', ''), 'A') ||
  rag_lexical_vector(COALESCE(metadata->>'heading_path', ''), 'B') ||
  rag_lexical_vector(content, 'D')
) STORED;
CREATE INDEX IF NOT EXISTS documents_lexical_vector_idx ON documents USING gin (lexical_vector);

CREATE OR REPLACE FUNCTION rag_document_matches_filters(
  page_id TEXT, page_title TEXT, metadata JSONB, filters JSONB
) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    (COALESCE(jsonb_array_length(filters->'pageIds'), 0) = 0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(filters->'pageIds') AS ids(value)
      WHERE replace(lower(ids.value), '-', '') = replace(lower(page_id), '-', '')
    ))
    AND (COALESCE(filters->>'titleContains', '') = ''
      OR strpos(lower(page_title), lower(filters->>'titleContains')) > 0)
    AND (COALESCE(jsonb_array_length(filters->'sourceTypes'), 0) = 0
      OR filters->'sourceTypes' ? COALESCE(metadata->>'source_type', 'notion'))
    AND (filters#>>'{timeRange,from}' IS NULL OR
      (metadata->>'last_edited_time')::timestamptz >= (filters#>>'{timeRange,from}')::timestamptz)
    AND (filters#>>'{timeRange,to}' IS NULL OR
      (metadata->>'last_edited_time')::timestamptz <= (filters#>>'{timeRange,to}')::timestamptz);
$$;

CREATE OR REPLACE FUNCTION match_documents_keyword_filtered(
  query_text TEXT, match_count INT DEFAULT 20, filter_user_id UUID DEFAULT NULL,
  retrieval_filters JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  id UUID, page_id TEXT, page_title TEXT, page_url TEXT, content TEXT,
  metadata JSONB, embedding_text TEXT, keyword_rank FLOAT
)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  query_terms TEXT[];
  parsed_query TSQUERY;
BEGIN
  query_terms := rag_lexical_terms(query_text);
  IF cardinality(query_terms) = 0 THEN RETURN; END IF;
  SELECT string_agg(quote_literal(term), ' | ')::tsquery INTO parsed_query
    FROM unnest(query_terms) AS term;
  RETURN QUERY
  SELECT d.id, p.page_id, p.page_title, p.page_url, d.content, d.metadata,
    d.embedding::TEXT,
    LEAST(1.0, (
      -- Body coverage measures relevance; title/heading weight breaks ranking ties.
      0.8 * (SELECT COUNT(*)::FLOAT FROM unnest(query_terms) AS term
        WHERE term = ANY(rag_lexical_terms(d.content))) / cardinality(query_terms)
      + 0.2 * ts_rank(d.lexical_vector, parsed_query, 32)
    ))::FLOAT AS keyword_rank
  FROM documents d JOIN notion_pages p ON d.notion_page_id = p.id
  WHERE p.user_id = filter_user_id
    AND rag_document_matches_filters(p.page_id, p.page_title, d.metadata, retrieval_filters)
    AND d.lexical_vector @@ parsed_query
  ORDER BY keyword_rank DESC, p.page_title ASC, d.id ASC
  LIMIT LEAST(GREATEST(match_count, 1), 50);
END;
$$;

CREATE OR REPLACE FUNCTION match_documents_keyword(
  query_text TEXT, match_count INT DEFAULT 20, filter_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID, page_id TEXT, page_title TEXT, page_url TEXT, content TEXT,
  metadata JSONB, embedding_text TEXT, keyword_rank FLOAT
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT * FROM match_documents_keyword_filtered(query_text, match_count, filter_user_id, '{}'::JSONB);
$$;

REVOKE ALL ON FUNCTION match_documents_keyword(TEXT, INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_documents_keyword_filtered(TEXT, INT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_documents_keyword(TEXT, INT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION match_documents_keyword_filtered(TEXT, INT, UUID, JSONB) TO service_role;
COMMIT;
