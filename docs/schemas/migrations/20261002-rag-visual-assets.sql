-- Apply after 20261002-rag-file-sources.sql. All publishing remains service-role only.
BEGIN;
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS visual_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_files ADD COLUMN IF NOT EXISTS active_generation_id uuid;
CREATE TABLE IF NOT EXISTS knowledge_file_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  pipeline_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('preparing','ready','active','failed','superseded')),
  visual_status text NOT NULL DEFAULT 'partial',
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE TABLE IF NOT EXISTS knowledge_visual_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES knowledge_file_generations(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pdf_page','embedded_image')),
  occurrence_key text NOT NULL,
  page_number integer CHECK (page_number BETWEEN 1 AND 200),
  text_start integer, text_end integer,
  alt_text text NOT NULL DEFAULT '',
  storage_path text, mime_type text, blob_sha256 text,
  render_status text NOT NULL CHECK (render_status IN ('pending','ready','failed')),
  analysis_status text NOT NULL CHECK (analysis_status IN ('ready','failed','skipped')),
  description text NOT NULL DEFAULT '',
  analysis_model text,
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(generation_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS visual_assets_owner_file_idx ON knowledge_visual_assets(user_id,file_id,generation_id);
CREATE INDEX IF NOT EXISTS visual_generations_cleanup_idx ON knowledge_file_generations(status,created_at);
ALTER TABLE knowledge_file_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_visual_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visual_generations_owner_read ON knowledge_file_generations;
CREATE POLICY visual_generations_owner_read ON knowledge_file_generations FOR SELECT USING(auth.uid()=user_id);
DROP POLICY IF EXISTS visual_assets_owner_read ON knowledge_visual_assets;
CREATE POLICY visual_assets_owner_read ON knowledge_visual_assets FOR SELECT USING(auth.uid()=user_id);

CREATE TABLE IF NOT EXISTS knowledge_visual_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_visual_cleanup ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION enqueue_visual_object_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.storage_path IS NOT NULL THEN
    INSERT INTO knowledge_visual_cleanup(storage_path) VALUES(OLD.storage_path) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS visual_object_cleanup ON knowledge_visual_assets;
CREATE TRIGGER visual_object_cleanup BEFORE DELETE ON knowledge_visual_assets
FOR EACH ROW EXECUTE FUNCTION enqueue_visual_object_cleanup();

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('knowledge-visuals','knowledge-visuals',false,5242880,ARRAY['image/png','image/jpeg'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
-- No direct authenticated Storage policy: reads go through file ownership and active-generation checks.

-- Keep the original implementation private and add a guard for late text-only workers.
DO $$ BEGIN
  IF to_regprocedure('public.sync_knowledge_documents_core(uuid,text,text,text,timestamptz,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION sync_notion_page_documents_atomic(uuid,text,text,text,timestamptz,jsonb,jsonb)
      RENAME TO sync_knowledge_documents_core;
  END IF;
END $$;
REVOKE ALL ON FUNCTION sync_knowledge_documents_core(uuid,text,text,text,timestamptz,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_knowledge_documents_core(uuid,text,text,text,timestamptz,jsonb,jsonb) FROM service_role;
CREATE OR REPLACE FUNCTION sync_notion_page_documents_atomic(
  p_user_id uuid,p_page_id text,p_page_title text,p_page_url text,
  p_last_edited_time timestamptz,p_page_metadata jsonb,p_documents jsonb
) RETURNS TABLE(page_row_id uuid,inserted_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_page_id,0));
  IF p_page_id LIKE 'file:%' AND EXISTS (
    SELECT 1 FROM knowledge_files WHERE user_id=p_user_id AND 'file:'||id::text=p_page_id
      AND visual_enabled AND p_page_metadata->>'generation_id' IS NULL
  ) THEN RAISE EXCEPTION 'visual indexing enabled; late text-only publication refused'; END IF;
  RETURN QUERY SELECT * FROM sync_knowledge_documents_core(
    p_user_id,p_page_id,p_page_title,p_page_url,p_last_edited_time,p_page_metadata,p_documents);
END $$;
REVOKE ALL ON FUNCTION sync_notion_page_documents_atomic(uuid,text,text,text,timestamptz,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_notion_page_documents_atomic(uuid,text,text,text,timestamptz,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION enable_knowledge_visual_index(p_user_id uuid,p_file_id uuid)
RETURNS SETOF rag_ingestion_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':file:'||p_file_id::text,0));
  UPDATE knowledge_files SET visual_enabled=true,updated_at=now() WHERE id=p_file_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge file not found' USING ERRCODE='P0002'; END IF;
  UPDATE rag_ingestion_jobs SET status='cancelled',lease_until=NULL,updated_at=now()
    WHERE user_id=p_user_id AND page_id='file:'||p_file_id::text AND status IN ('queued','running','retry_wait');
  RETURN QUERY SELECT * FROM enqueue_rag_ingestion_job(p_user_id,'file:'||p_file_id::text,false,true,NULL,3);
END $$;
REVOKE ALL ON FUNCTION enable_knowledge_visual_index(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enable_knowledge_visual_index(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION publish_knowledge_visual_generation(
  p_user_id uuid,p_page_id text,p_page_title text,p_page_url text,
  p_last_edited_time timestamptz,p_page_metadata jsonb,p_documents jsonb
) RETURNS TABLE(page_row_id uuid,inserted_count integer)
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  v_file knowledge_files;
  v_generation knowledge_file_generations;
  v_expected uuid := NULLIF(p_page_metadata->>'expected_generation_id','')::uuid;
  v_id uuid := (p_page_metadata->>'generation_id')::uuid;
  v_lease jsonb := p_page_metadata->'ingestion_lease';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_page_id,0));
  SELECT * INTO v_file FROM knowledge_files
    WHERE user_id=p_user_id AND 'file:'||id::text=p_page_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge file no longer exists' USING ERRCODE='P0002'; END IF;
  IF v_file.active_generation_id IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'stale generation'; END IF;
  SELECT * INTO v_generation FROM knowledge_file_generations WHERE id=v_id AND user_id=p_user_id AND file_id=v_file.id FOR UPDATE;
  IF NOT FOUND OR v_generation.status<>'ready' OR v_generation.source_version<>v_file.sha256
    OR p_page_metadata->>'source_version' IS DISTINCT FROM v_file.sha256 THEN
    RAISE EXCEPTION 'invalid generation';
  END IF;
  IF v_lease IS NOT NULL THEN
    PERFORM 1 FROM rag_ingestion_jobs WHERE id=(v_lease->>'jobId')::uuid AND user_id=p_user_id
      AND page_id=p_page_id AND status='running' AND worker_id=v_lease->>'workerId'
      AND attempts=(v_lease->>'attempts')::integer AND lease_until>now()
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ingestion lease lost'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM knowledge_visual_assets WHERE generation_id=v_id
    AND (user_id<>p_user_id OR file_id<>v_file.id OR source_version<>v_file.sha256)) THEN
    RAISE EXCEPTION 'visual resource ownership mismatch';
  END IF;
  RETURN QUERY SELECT * FROM sync_notion_page_documents_atomic(
    p_user_id,p_page_id,p_page_title,p_page_url,p_last_edited_time,p_page_metadata,p_documents);
  UPDATE knowledge_file_generations SET status='superseded' WHERE id=v_file.active_generation_id;
  UPDATE knowledge_file_generations SET status='active',published_at=now() WHERE id=v_id;
  UPDATE knowledge_files SET active_generation_id=v_id,updated_at=now() WHERE id=v_file.id;
END $$;
REVOKE ALL ON FUNCTION publish_knowledge_visual_generation(uuid,text,text,text,timestamptz,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_knowledge_visual_generation(uuid,text,text,text,timestamptz,jsonb,jsonb) TO service_role;
COMMIT;
