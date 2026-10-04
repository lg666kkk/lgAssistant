-- RAG 自定义文件数据源。
-- 目标：
-- 1. notion_pages 增加 source_type，作为通用的「知识源」表复用（notion / document）。
--    取值与检索过滤 filters.sourceTypes 一致（上传文件 = document）。
-- 2. knowledge_files 记录用户上传文件的元数据；文件内容存 Storage 私有 bucket。
-- 3. 文件在索引中的 page_id 固定为 file:<knowledge_files.id>，复用 documents 外键级联、
--    检索 RPC、版本快照与 ingestion 队列。
-- 4. 原子写入 RPC 从 p_page_metadata->>'source_type' 写入 source_type，签名不变。

BEGIN;

ALTER TABLE notion_pages
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'notion';

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

-- 队列按 page_id 前缀区分来源，生成列便于观测和过滤。
ALTER TABLE rag_ingestion_jobs
  ADD COLUMN IF NOT EXISTS source_type TEXT
  GENERATED ALWAYS AS (
    CASE WHEN page_id LIKE 'file:%' THEN 'document' ELSE 'notion' END
  ) STORED;

-- 私有 bucket，对象 key：<user_id>/<file_id>/<sanitized-file-name>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'knowledge-files',
  'knowledge-files',
  false,
  20971520,
  ARRAY[
    'text/markdown',
    'text/plain',
    'text/html',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS knowledge_files_owner_select ON storage.objects;
CREATE POLICY knowledge_files_owner_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'knowledge-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

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
    user_id,
    page_id,
    page_title,
    page_url,
    last_edited_time,
    last_synced_at,
    chunk_count,
    metadata,
    source_type
  )
  VALUES (
    p_user_id,
    p_page_id,
    p_page_title,
    p_page_url,
    p_last_edited_time,
    NOW(),
    jsonb_array_length(p_documents),
    COALESCE(p_page_metadata, '{}'::JSONB),
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
    user_id,
    notion_page_id,
    page_id,
    chunk_index,
    content,
    embedding,
    metadata
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


-- 删除与发布必须在同一事务锁下完成；Storage 对象在事务成功后清理。
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

COMMIT;
