-- RAG 多用户隔离结构迁移。
-- 目标：
-- 1. notion_pages 使用内部 id 作为主键。
-- 2. 同一个 Notion page_id 可被不同 user_id 各自同步。
-- 3. documents 使用 notion_page_id 外键级联删除，同时保留 page_id 冗余字段用于展示。

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS notion_page_id UUID;

UPDATE documents d
SET notion_page_id = p.id,
    user_id = COALESCE(d.user_id, p.user_id)
FROM notion_pages p
WHERE d.notion_page_id IS NULL
  AND d.page_id = p.page_id
  AND (d.user_id = p.user_id OR d.user_id IS NULL OR p.user_id IS NULL);

DO $$
DECLARE
  pk_columns TEXT[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'documents_page_id_fkey'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents DROP CONSTRAINT documents_page_id_fkey;
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attnum)
  INTO pk_columns
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON TRUE
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.conname = 'notion_pages_pkey'
    AND c.conrelid = 'notion_pages'::regclass;

  IF pk_columns IS NULL THEN
    ALTER TABLE notion_pages ADD CONSTRAINT notion_pages_pkey PRIMARY KEY (id);
  ELSIF pk_columns = ARRAY['id']::TEXT[] THEN
    -- 已经迁移完成，保持现状。
    NULL;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'documents_notion_page_id_fkey'
        AND conrelid = 'documents'::regclass
    ) THEN
      ALTER TABLE documents DROP CONSTRAINT documents_notion_page_id_fkey;
    END IF;

    ALTER TABLE notion_pages DROP CONSTRAINT notion_pages_pkey;
    ALTER TABLE notion_pages ADD CONSTRAINT notion_pages_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notion_pages_user_page_unique_idx
ON notion_pages (user_id, page_id);

CREATE INDEX IF NOT EXISTS notion_pages_user_id_synced_idx
ON notion_pages (user_id, last_synced_at DESC);

CREATE INDEX IF NOT EXISTS documents_notion_page_id_idx
ON documents (notion_page_id);

CREATE INDEX IF NOT EXISTS documents_user_id_page_idx
ON documents (user_id, page_id, chunk_index);

DROP INDEX IF EXISTS documents_page_chunk_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS documents_notion_page_chunk_unique_idx
ON documents (notion_page_id, chunk_index);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'documents_notion_page_id_fkey'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_notion_page_id_fkey
      FOREIGN KEY (notion_page_id)
      REFERENCES notion_pages(id)
      ON DELETE CASCADE;
  END IF;
END $$;

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
    p.page_id,
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
