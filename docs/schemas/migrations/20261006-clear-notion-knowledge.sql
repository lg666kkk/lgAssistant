-- One-click Notion reset, isolated to the current user. Apply before deploying the UI.
BEGIN;

-- Keep the connection row and advance revision to fence off pre-clear syncs.
CREATE OR REPLACE FUNCTION clear_user_notion_knowledge(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pages INTEGER;
  v_documents INTEGER;
  v_snapshots INTEGER;
  v_jobs INTEGER;
  v_page_ids TEXT[];
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;

  INSERT INTO user_knowledge_connections (user_id, provider)
  VALUES (p_user_id, 'notion')
  ON CONFLICT (user_id, provider) DO NOTHING;
  PERFORM 1 FROM user_knowledge_connections
    WHERE user_id = p_user_id AND provider = 'notion' FOR UPDATE;

  UPDATE user_knowledge_connections
  SET enabled = FALSE, credentials_ciphertext = '', credentials_hint = '',
      settings = jsonb_build_object('defaultRecursive', TRUE, 'maxDepth', 8,
        'clearedAt', NOW()),
      revision = revision + 1, last_test_status = NULL,
      last_test_error = NULL, last_tested_at = NULL, updated_at = NOW()
  WHERE user_id = p_user_id AND provider = 'notion';

  SELECT COALESCE(array_agg(page_id), '{}'::TEXT[]) INTO v_page_ids
  FROM notion_pages WHERE user_id = p_user_id AND source_type = 'notion';

  -- Remove derived Wiki pages that contain deleted Notion material.
  DELETE FROM compiled_wiki_edges
  WHERE user_id = p_user_id AND from_slug IN (
    SELECT slug FROM compiled_wiki_pages
    WHERE user_id = p_user_id AND source_page_ids && v_page_ids
  );
  DELETE FROM compiled_wiki_pages
  WHERE user_id = p_user_id AND source_page_ids && v_page_ids;
  -- Preserve the user's custom profile while invalidating generated knowledge summaries.
  UPDATE knowledge_profiles SET profile = '', source_hash = '', updated_at = NOW()
  WHERE user_id = p_user_id;

  DELETE FROM rag_ingestion_jobs
  WHERE user_id = p_user_id AND page_id NOT LIKE 'file:%';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  DELETE FROM rag_index_snapshots
  WHERE user_id = p_user_id AND page_id NOT LIKE 'file:%';
  GET DIAGNOSTICS v_snapshots = ROW_COUNT;
  DELETE FROM documents
  WHERE user_id = p_user_id AND (
    notion_page_id IN (SELECT id FROM notion_pages
      WHERE user_id = p_user_id AND source_type = 'notion')
    OR (notion_page_id IS NULL AND page_id NOT LIKE 'file:%'
      AND COALESCE(metadata->>'source_type', 'notion') = 'notion')
  );
  GET DIAGNOSTICS v_documents = ROW_COUNT;
  DELETE FROM notion_pages WHERE user_id = p_user_id AND source_type = 'notion';
  GET DIAGNOSTICS v_pages = ROW_COUNT;

  RETURN jsonb_build_object('pages', v_pages, 'documents', v_documents,
    'snapshots', v_snapshots, 'jobs', v_jobs);
END;
$$;
REVOKE ALL ON FUNCTION clear_user_notion_knowledge(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_user_notion_knowledge(UUID) TO service_role;

-- Serialize Notion writes with reset, including already-running background workers.
CREATE OR REPLACE FUNCTION guard_notion_connection_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_connection user_knowledge_connections%ROWTYPE;
  v_revision TEXT;
BEGIN
  IF NEW.source_type <> 'notion' THEN RETURN NEW; END IF;
  SELECT * INTO v_connection FROM user_knowledge_connections
  WHERE user_id = NEW.user_id AND provider = 'notion' FOR SHARE;
  IF v_connection.id IS NULL OR NOT v_connection.enabled
    OR v_connection.credentials_ciphertext = '' THEN
    RAISE EXCEPTION 'Notion connection was disabled or cleared';
  END IF;
  v_revision := NEW.metadata->>'notion_connection_revision';
  -- Metadata-only refreshes keep the existing index revision and cannot recreate deleted rows.
  IF TG_OP = 'UPDATE' AND v_revision IS NOT DISTINCT FROM
    OLD.metadata->>'notion_connection_revision' THEN RETURN NEW; END IF;
  IF (v_revision IS NOT NULL AND v_revision <> v_connection.revision::TEXT)
    OR (v_revision IS NULL AND v_connection.settings ? 'clearedAt') THEN
    RAISE EXCEPTION 'Notion connection changed; restart synchronization';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS notion_pages_connection_guard ON notion_pages;
CREATE TRIGGER notion_pages_connection_guard BEFORE INSERT OR UPDATE ON notion_pages
FOR EACH ROW EXECUTE FUNCTION guard_notion_connection_write();
REVOKE ALL ON FUNCTION guard_notion_connection_write() FROM PUBLIC;
COMMIT;
