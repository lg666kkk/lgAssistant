BEGIN;

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

CREATE OR REPLACE FUNCTION match_documents_filtered(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  filter_user_id UUID DEFAULT NULL,
  retrieval_filters JSONB DEFAULT '{}'::JSONB
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
    AND p.user_id = filter_user_id
    AND rag_document_matches_filters(p.page_id, p.page_title, d.metadata, retrieval_filters)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;



CREATE OR REPLACE FUNCTION match_documents_keyword_filtered(
  query_text TEXT,
  match_count INT DEFAULT 20,
  filter_user_id UUID DEFAULT NULL,
  retrieval_filters JSONB DEFAULT '{}'::JSONB
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
    WHERE p.user_id = filter_user_id
      AND rag_document_matches_filters(p.page_id, p.page_title, d.metadata, retrieval_filters)
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


CREATE OR REPLACE FUNCTION refresh_notion_page_metadata_atomic(
  p_user_id UUID, p_page_id TEXT, p_page_title TEXT, p_page_url TEXT,
  p_last_edited_time TIMESTAMPTZ, p_expected_content_hash TEXT
) RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_page_id UUID;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT || ':' || p_page_id, 0));
  SELECT id INTO v_page_id FROM notion_pages
    WHERE user_id = p_user_id AND page_id = p_page_id
      AND metadata->>'content_hash' = p_expected_content_hash FOR UPDATE;
  IF v_page_id IS NULL THEN RAISE EXCEPTION 'index changed during metadata refresh'; END IF;
  UPDATE notion_pages SET page_title = p_page_title, page_url = p_page_url,
    last_edited_time = p_last_edited_time, last_synced_at = NOW() WHERE id = v_page_id;
  UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'page_title', p_page_title, 'page_url', p_page_url, 'last_edited_time', p_last_edited_time
  ) WHERE notion_page_id = v_page_id AND user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION refresh_notion_page_metadata_atomic(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_notion_page_metadata_atomic(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
REVOKE ALL ON FUNCTION match_documents_filtered(VECTOR, FLOAT, INT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION match_documents_keyword_filtered(TEXT, INT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_documents_filtered(VECTOR, FLOAT, INT, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION match_documents_keyword_filtered(TEXT, INT, UUID, JSONB) TO service_role;
COMMIT;
