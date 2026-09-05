BEGIN;

ALTER TABLE sandbox_skills
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'legacy:unknown' CHECK (btrim(created_by) <> ''),
  ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT 'legacy:unknown' CHECK (btrim(updated_by) <> ''),
  ADD COLUMN IF NOT EXISTS skill_md TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS support_files JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE sandbox_skills
  ALTER COLUMN created_by DROP DEFAULT,
  ALTER COLUMN updated_by DROP DEFAULT;

DROP FUNCTION IF EXISTS upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN, TEXT);
CREATE FUNCTION upsert_sandbox_skill(
  p_id TEXT,
  p_name TEXT,
  p_description TEXT DEFAULT '',
  p_enabled BOOLEAN DEFAULT FALSE,
  p_actor_id TEXT DEFAULT NULL
)
RETURNS SETOF sandbox_skills
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO sandbox_skills (id, name, description, enabled, created_by, updated_by)
  VALUES (p_id, p_name, COALESCE(p_description, ''), COALESCE(p_enabled, FALSE), p_actor_id, p_actor_id)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    enabled = EXCLUDED.enabled,
    updated_by = p_actor_id,
    updated_at = NOW()
  WHERE sandbox_skills.deleted_at IS NULL
  RETURNING *;
$$;

DROP FUNCTION IF EXISTS delete_sandbox_skill(TEXT, TEXT);
CREATE FUNCTION delete_sandbox_skill(p_id TEXT, p_actor_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sandbox_runs
    WHERE skill_id = p_id
      AND status IN ('queued', 'preparing', 'running', 'collecting_artifacts', 'retry_wait')
  ) THEN
    RAISE EXCEPTION 'skill has active sandbox runs'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  UPDATE sandbox_skills
  SET enabled = FALSE, deleted_by = p_actor_id, deleted_at = NOW(),
      updated_by = p_actor_id, updated_at = NOW()
  WHERE id = p_id AND deleted_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_sandbox_skill(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION delete_sandbox_skill(TEXT, TEXT) TO service_role;

COMMIT;
