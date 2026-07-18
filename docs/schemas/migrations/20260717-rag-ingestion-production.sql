BEGIN;

CREATE TABLE IF NOT EXISTS rag_ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  tree BOOLEAN NOT NULL DEFAULT TRUE,
  force BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'dead', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  worker_id TEXT,
  last_error TEXT,
  result JSONB,
  trace_id TEXT,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rag_ingestion_jobs_claim_idx
  ON rag_ingestion_jobs (status, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS rag_ingestion_jobs_user_created_idx
  ON rag_ingestion_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_ingestion_jobs_dead_idx
  ON rag_ingestion_jobs (updated_at DESC)
  WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS rag_ingestion_jobs_retention_idx
  ON rag_ingestion_jobs (retention_until);

ALTER TABLE rag_ingestion_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "用户只能读取自己的 RAG ingestion jobs" ON rag_ingestion_jobs;
CREATE POLICY "用户只能读取自己的 RAG ingestion jobs"
  ON rag_ingestion_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION enqueue_rag_ingestion_job(
  p_user_id UUID,
  p_page_id TEXT,
  p_tree BOOLEAN DEFAULT TRUE,
  p_force BOOLEAN DEFAULT FALSE,
  p_trace_id TEXT DEFAULT NULL,
  p_max_attempts INTEGER DEFAULT 3
)
RETURNS SETOF rag_ingestion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_id UUID;
BEGIN
  IF p_user_id IS NULL OR btrim(p_page_id) = '' THEN
    RAISE EXCEPTION 'user_id and page_id are required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT || ':' || p_page_id, 0));

  SELECT id INTO existing_id
  FROM rag_ingestion_jobs
  WHERE user_id = p_user_id
    AND page_id = p_page_id
    AND status IN ('queued', 'running', 'retry_wait')
  ORDER BY created_at DESC
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN QUERY
    UPDATE rag_ingestion_jobs AS jobs
    SET force = jobs.force OR p_force,
        tree = jobs.tree OR p_tree,
        trace_id = COALESCE(p_trace_id, jobs.trace_id),
        updated_at = NOW()
    WHERE jobs.id = existing_id
    RETURNING jobs.*;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO rag_ingestion_jobs (
    user_id, page_id, tree, force, trace_id, max_attempts
  ) VALUES (
    p_user_id,
    p_page_id,
    COALESCE(p_tree, TRUE),
    COALESCE(p_force, FALSE),
    p_trace_id,
    LEAST(GREATEST(COALESCE(p_max_attempts, 3), 1), 8)
  )
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION claim_rag_ingestion_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS SETOF rag_ingestion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF btrim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM rag_ingestion_jobs
    WHERE (
      status IN ('queued', 'retry_wait')
      AND next_attempt_at <= NOW()
    ) OR (
      status = 'running'
      AND lease_until <= NOW()
    )
    ORDER BY next_attempt_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 20)
  )
  UPDATE rag_ingestion_jobs AS jobs
  SET status = 'running',
      attempts = jobs.attempts + 1,
      worker_id = p_worker_id,
      lease_until = NOW() + make_interval(
        secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 30), 1800)
      ),
      updated_at = NOW()
  FROM claimable
  WHERE jobs.id = claimable.id
  RETURNING jobs.*;
END;
$$;

REVOKE ALL ON FUNCTION enqueue_rag_ingestion_job(UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_rag_ingestion_jobs(TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_rag_ingestion_job(UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION claim_rag_ingestion_jobs(TEXT, INTEGER, INTEGER) TO service_role;

CREATE TABLE IF NOT EXISTS rag_index_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  index_version TEXT NOT NULL,
  page_payload JSONB NOT NULL,
  document_payload JSONB NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, page_id, index_version)
);

CREATE INDEX IF NOT EXISTS rag_index_snapshots_user_page_idx
  ON rag_index_snapshots (user_id, page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_index_snapshots_retention_idx
  ON rag_index_snapshots (retention_until);
ALTER TABLE rag_index_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "用户只能读取自己的 RAG index snapshots" ON rag_index_snapshots;
CREATE POLICY "用户只能读取自己的 RAG index snapshots"
  ON rag_index_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION snapshot_rag_index_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_version TEXT;
  old_documents JSONB;
BEGIN
  old_version := COALESCE(
    OLD.metadata->>'index_version',
    OLD.metadata->>'content_hash',
    'legacy-' || replace(OLD.last_synced_at::TEXT, ' ', 'T')
  );
  IF old_version = COALESCE(NEW.metadata->>'index_version', NEW.metadata->>'content_hash') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'chunk_index', d.chunk_index,
    'content', d.content,
    'embedding', (d.embedding::TEXT)::JSONB,
    'metadata', d.metadata
  ) ORDER BY d.chunk_index), '[]'::JSONB)
  INTO old_documents
  FROM documents d
  WHERE d.notion_page_id = OLD.id
    AND d.user_id = OLD.user_id;

  INSERT INTO rag_index_snapshots (
    user_id, page_id, index_version, page_payload, document_payload
  ) VALUES (
    OLD.user_id,
    OLD.page_id,
    old_version,
    jsonb_build_object(
      'page_title', OLD.page_title,
      'page_url', OLD.page_url,
      'last_edited_time', OLD.last_edited_time,
      'last_synced_at', OLD.last_synced_at,
      'chunk_count', OLD.chunk_count,
      'metadata', OLD.metadata
    ),
    old_documents
  )
  ON CONFLICT (user_id, page_id, index_version) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notion_pages_snapshot_index_before_update ON notion_pages;
CREATE TRIGGER notion_pages_snapshot_index_before_update
BEFORE UPDATE ON notion_pages
FOR EACH ROW EXECUTE FUNCTION snapshot_rag_index_before_update();

CREATE OR REPLACE FUNCTION rollback_rag_page_index(
  p_user_id UUID,
  p_page_id TEXT,
  p_index_version TEXT
)
RETURNS TABLE (page_row_id UUID, restored_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  page_row notion_pages%ROWTYPE;
  snapshot_row rag_index_snapshots%ROWTYPE;
  inserted_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT || ':' || p_page_id, 0));

  SELECT * INTO page_row
  FROM notion_pages
  WHERE user_id = p_user_id AND page_id = p_page_id
  FOR UPDATE;
  IF page_row.id IS NULL THEN RAISE EXCEPTION 'active page index not found'; END IF;

  SELECT * INTO snapshot_row
  FROM rag_index_snapshots
  WHERE user_id = p_user_id
    AND page_id = p_page_id
    AND index_version = p_index_version;
  IF snapshot_row.id IS NULL THEN RAISE EXCEPTION 'requested index snapshot not found'; END IF;
  IF jsonb_array_length(snapshot_row.document_payload) = 0 THEN
    RAISE EXCEPTION 'requested index snapshot has no documents';
  END IF;

  UPDATE notion_pages
  SET page_title = snapshot_row.page_payload->>'page_title',
      page_url = snapshot_row.page_payload->>'page_url',
      last_edited_time = (snapshot_row.page_payload->>'last_edited_time')::TIMESTAMPTZ,
      last_synced_at = NOW(),
      chunk_count = jsonb_array_length(snapshot_row.document_payload),
      metadata = COALESCE(snapshot_row.page_payload->'metadata', '{}'::JSONB)
  WHERE id = page_row.id;

  DELETE FROM documents
  WHERE notion_page_id = page_row.id AND user_id = p_user_id;

  INSERT INTO documents (
    user_id, notion_page_id, page_id, chunk_index, content, embedding, metadata
  )
  SELECT
    p_user_id,
    page_row.id,
    p_page_id,
    (item.value->>'chunk_index')::INTEGER,
    item.value->>'content',
    (item.value->>'embedding')::VECTOR(1024),
    COALESCE(item.value->'metadata', '{}'::JSONB)
  FROM jsonb_array_elements(snapshot_row.document_payload) AS item(value);

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> jsonb_array_length(snapshot_row.document_payload) THEN
    RAISE EXCEPTION 'rollback document count mismatch';
  END IF;
  RETURN QUERY SELECT page_row.id, inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION rollback_rag_page_index(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rollback_rag_page_index(UUID, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION purge_expired_rag_operational_data()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_snapshots INTEGER;
  deleted_jobs INTEGER;
BEGIN
  DELETE FROM rag_index_snapshots WHERE retention_until <= NOW();
  GET DIAGNOSTICS deleted_snapshots = ROW_COUNT;

  DELETE FROM rag_ingestion_jobs
  WHERE retention_until <= NOW()
    AND status IN ('completed', 'dead', 'cancelled');
  GET DIAGNOSTICS deleted_jobs = ROW_COUNT;
  RETURN deleted_snapshots + deleted_jobs;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_rag_operational_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_rag_operational_data() TO service_role;

COMMIT;
