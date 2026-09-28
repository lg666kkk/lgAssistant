BEGIN;

ALTER TABLE sandbox_skill_versions
  ADD COLUMN IF NOT EXISTS e2b_template_id TEXT;
ALTER TABLE sandbox_skill_versions
  ALTER COLUMN image_digest DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sandbox_skill_versions'::regclass
      AND conname = 'sandbox_skill_versions_execution_target_check'
  ) THEN
    ALTER TABLE sandbox_skill_versions
      ADD CONSTRAINT sandbox_skill_versions_execution_target_check
      CHECK ((e2b_template_id IS NOT NULL) <> (image_digest IS NOT NULL));
  END IF;
END;
$$;

ALTER TABLE sandbox_runs
  ADD COLUMN IF NOT EXISTS e2b_sandbox_id TEXT,
  ADD COLUMN IF NOT EXISTS stdout TEXT,
  ADD COLUMN IF NOT EXISTS stderr TEXT;

DROP FUNCTION IF EXISTS publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION publish_sandbox_skill_version(
  p_skill_id TEXT,
  p_version TEXT,
  p_runtime TEXT,
  p_entrypoint JSONB,
  p_profile_id TEXT,
  p_template_id TEXT,
  p_bundle_sha256 TEXT,
  p_bundle_base64 TEXT,
  p_input_schema_path TEXT,
  p_output_schema_path TEXT,
  p_actor_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  published_at TIMESTAMPTZ;
BEGIN
  INSERT INTO sandbox_skill_versions (
    skill_id, version, runtime, entrypoint, profile_id, e2b_template_id,
    bundle_sha256, bundle, network, input_schema_path, output_schema_path, created_by
  ) VALUES (
    p_skill_id, p_version, p_runtime, p_entrypoint, p_profile_id, p_template_id,
    p_bundle_sha256, decode(p_bundle_base64, 'base64'), 'disabled',
    p_input_schema_path, p_output_schema_path, p_actor_id
  ) RETURNING created_at INTO published_at;
  RETURN jsonb_build_object(
    'skillId', p_skill_id,
    'version', p_version,
    'bundleSha256', p_bundle_sha256,
    'createdAt', published_at
  );
END;
$$;

REVOKE ALL ON FUNCTION publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
