BEGIN;

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

  INSERT INTO notion_pages (
    user_id,
    page_id,
    page_title,
    page_url,
    last_edited_time,
    last_synced_at,
    chunk_count,
    metadata
  )
  VALUES (
    p_user_id,
    p_page_id,
    p_page_title,
    p_page_url,
    p_last_edited_time,
    NOW(),
    jsonb_array_length(p_documents),
    COALESCE(p_page_metadata, '{}'::JSONB)
  )
  ON CONFLICT (user_id, page_id)
  DO UPDATE SET
    page_title = EXCLUDED.page_title,
    page_url = EXCLUDED.page_url,
    last_edited_time = EXCLUDED.last_edited_time,
    last_synced_at = EXCLUDED.last_synced_at,
    chunk_count = EXCLUDED.chunk_count,
    metadata = EXCLUDED.metadata
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
) IS 'Atomically upserts one Notion page and replaces all of its RAG document chunks';

COMMIT;
