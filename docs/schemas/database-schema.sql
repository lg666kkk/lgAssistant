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

-- 5. 创建向量相似度检索 RPC 函数
-- 清掉旧版 3 参数函数，避免 Postgres 同名重载导致 COMMENT/RPC 歧义。
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
  JOIN notion_pages p ON d.notion_page_id = p.id
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    AND (filter_user_id IS NULL OR p.user_id = filter_user_id)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents(VECTOR(1024), FLOAT, INT, UUID) IS '向量相似度检索函数';

-- 6. 创建关键词检索 RPC 函数（用于 vector + keyword 混合检索）
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

-- 7. 创建检查是否需要更新的函数
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

-- 8. LLM 编译知识库：wiki 页面和关系边
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
