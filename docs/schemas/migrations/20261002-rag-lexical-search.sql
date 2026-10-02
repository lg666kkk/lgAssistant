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
