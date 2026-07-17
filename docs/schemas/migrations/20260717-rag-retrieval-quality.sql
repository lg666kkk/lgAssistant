BEGIN;

DROP FUNCTION IF EXISTS match_documents(VECTOR(1024), FLOAT, INT);
DROP FUNCTION IF EXISTS match_documents(VECTOR(1024), FLOAT, INT, UUID);

CREATE FUNCTION match_documents(
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

COMMENT ON FUNCTION match_documents(VECTOR(1024), FLOAT, INT, UUID)
IS 'Vector retrieval with stored embedding payload for vector MMR';

DROP FUNCTION IF EXISTS match_documents_keyword(TEXT, INT, UUID);

CREATE FUNCTION match_documents_keyword(
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

COMMENT ON FUNCTION match_documents_keyword(TEXT, INT, UUID)
IS 'Keyword retrieval with stored embedding payload for vector MMR';

COMMIT;
