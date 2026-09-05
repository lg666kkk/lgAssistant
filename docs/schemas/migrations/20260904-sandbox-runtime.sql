BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sandbox_skills (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  updated_by TEXT NOT NULL CHECK (btrim(updated_by) <> ''),
  deleted_by TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS sandbox_skill_versions (
  skill_id TEXT NOT NULL REFERENCES sandbox_skills(id) ON DELETE RESTRICT,
  version TEXT NOT NULL CHECK (version ~ '^v?[0-9]+\.[0-9]+\.[0-9]+$'),
  runtime TEXT NOT NULL CHECK (runtime IN ('node', 'python')),
  entrypoint JSONB NOT NULL CHECK (
    jsonb_typeof(entrypoint) = 'array'
    AND jsonb_array_length(entrypoint) BETWEEN 1 AND 16
  ),
  profile_id TEXT NOT NULL CHECK (profile_id IN ('skill-trusted', 'coding-untrusted')),
  image_digest TEXT NOT NULL CHECK (image_digest ~ '@sha256:[0-9a-f]{64}$'),
  bundle_sha256 TEXT NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle BYTEA NOT NULL CHECK (octet_length(bundle) BETWEEN 1 AND 10485760),
  network TEXT NOT NULL DEFAULT 'disabled' CHECK (network = 'disabled'),
  input_schema_path TEXT NOT NULL,
  output_schema_path TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_id, version),
  CHECK (encode(digest(bundle, 'sha256'), 'hex') = bundle_sha256)
);

ALTER TABLE sandbox_skill_versions
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'legacy:unknown' CHECK (btrim(created_by) <> '');

ALTER TABLE sandbox_skill_versions
  ALTER COLUMN created_by DROP DEFAULT;

CREATE OR REPLACE FUNCTION reject_sandbox_skill_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'published sandbox skill versions are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS sandbox_skill_versions_immutable ON sandbox_skill_versions;
CREATE TRIGGER sandbox_skill_versions_immutable
BEFORE UPDATE OR DELETE ON sandbox_skill_versions
FOR EACH ROW EXECUTE FUNCTION reject_sandbox_skill_version_mutation();

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

DROP FUNCTION IF EXISTS publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION publish_sandbox_skill_version(
  p_skill_id TEXT,
  p_version TEXT,
  p_runtime TEXT,
  p_entrypoint JSONB,
  p_profile_id TEXT,
  p_image_digest TEXT,
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
  decoded_bundle BYTEA;
  published_at TIMESTAMPTZ;
BEGIN
  decoded_bundle := decode(p_bundle_base64, 'base64');
  INSERT INTO sandbox_skill_versions (
    skill_id, version, runtime, entrypoint, profile_id, image_digest,
    bundle_sha256, bundle, network, input_schema_path, output_schema_path, created_by
  ) VALUES (
    p_skill_id, p_version, p_runtime, p_entrypoint, p_profile_id, p_image_digest,
    p_bundle_sha256, decoded_bundle, 'disabled', p_input_schema_path, p_output_schema_path, p_actor_id
  )
  RETURNING created_at INTO published_at;
  RETURN jsonb_build_object(
    'skillId', p_skill_id,
    'version', p_version,
    'bundleSha256', p_bundle_sha256,
    'createdAt', published_at
  );
END;
$$;

CREATE TABLE IF NOT EXISTS sandbox_runs (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  user_id TEXT NOT NULL CHECK (btrim(user_id) <> ''),
  session_id TEXT,
  request_id TEXT NOT NULL,
  tool_call_id TEXT,
  kind TEXT NOT NULL DEFAULT 'command'
    CHECK (kind IN ('command', 'skill', 'coding')),
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL DEFAULT 'v1',
  skill_id TEXT,
  skill_version TEXT,
  skill_bundle_sha256 TEXT,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'array'),
  input JSONB NOT NULL DEFAULT '{}'::JSONB,
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 3600),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'preparing', 'running', 'collecting_artifacts',
      'completed', 'failed', 'timed_out', 'cancelled',
      'retry_wait', 'dead', 'unavailable'
    )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
  worker_id TEXT,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  image_digest TEXT,
  exit_code INTEGER,
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  oom_killed BOOLEAN NOT NULL DEFAULT FALSE,
  stdout_ref TEXT,
  stderr_ref TEXT,
  patch_ref TEXT,
  result_ref TEXT,
  result JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (skill_id, skill_version)
    REFERENCES sandbox_skill_versions(skill_id, version) ON DELETE RESTRICT,
  CHECK (
    (kind = 'skill' AND skill_id IS NOT NULL AND skill_version IS NOT NULL AND skill_bundle_sha256 IS NOT NULL)
    OR (kind <> 'skill' AND skill_id IS NULL AND skill_version IS NULL AND skill_bundle_sha256 IS NULL)
  ),
  CHECK (
    (lease_token IS NULL AND lease_until IS NULL)
    OR (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);

ALTER TABLE sandbox_runs
  ADD COLUMN IF NOT EXISTS result_ref TEXT,
  ADD COLUMN IF NOT EXISTS result JSONB;

CREATE INDEX IF NOT EXISTS sandbox_runs_claim_idx
  ON sandbox_runs (status, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS sandbox_runs_user_created_idx
  ON sandbox_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sandbox_runs_active_worker_idx
  ON sandbox_runs (worker_id, lease_until)
  WHERE status IN ('preparing', 'running', 'collecting_artifacts');

CREATE TABLE IF NOT EXISTS sandbox_events (
  run_id TEXT NOT NULL REFERENCES sandbox_runs(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS sandbox_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL REFERENCES sandbox_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('stdout', 'stderr', 'patch', 'result', 'test_report')),
  ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 0 AND 10485760),
  content_type TEXT NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sandbox_artifacts_run_idx
  ON sandbox_artifacts (run_id, created_at);
CREATE INDEX IF NOT EXISTS sandbox_artifacts_retention_idx
  ON sandbox_artifacts (retention_until);

CREATE TABLE IF NOT EXISTS sandbox_approval_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES sandbox_runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('apply_patch')),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  baseline_commit TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

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

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_approval_once_idx
  ON sandbox_approval_grants (run_id, action)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION validate_sandbox_run_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('preparing', 'cancelled', 'dead', 'unavailable')) OR
    (OLD.status = 'preparing' AND NEW.status IN ('running', 'retry_wait', 'failed', 'dead', 'cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('preparing', 'collecting_artifacts', 'retry_wait', 'failed', 'timed_out', 'dead', 'cancelled')) OR
    (OLD.status = 'collecting_artifacts' AND NEW.status IN ('preparing', 'completed', 'retry_wait', 'failed', 'dead', 'cancelled')) OR
    (OLD.status = 'retry_wait' AND NEW.status IN ('queued', 'preparing', 'dead', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid sandbox run transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sandbox_runs_validate_transition ON sandbox_runs;
CREATE TRIGGER sandbox_runs_validate_transition
BEFORE UPDATE OF status ON sandbox_runs
FOR EACH ROW EXECUTE FUNCTION validate_sandbox_run_transition();

CREATE OR REPLACE FUNCTION claim_sandbox_runs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 2,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS SETOF sandbox_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF btrim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  UPDATE sandbox_runs
  SET status = 'dead',
      worker_id = NULL,
      lease_token = NULL,
      lease_until = NULL,
      completed_at = NOW(),
      error_code = 'attempts_exhausted',
      error_message = COALESCE(error_message, 'worker lease expired after final attempt'),
      updated_at = NOW()
  WHERE attempts >= max_attempts
    AND (
      (status IN ('preparing', 'running', 'collecting_artifacts') AND lease_until <= NOW())
      OR status IN ('queued', 'retry_wait')
    );

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM sandbox_runs
    WHERE cancel_requested_at IS NULL
      AND attempts < max_attempts
      AND (
        (status IN ('queued', 'retry_wait') AND next_attempt_at <= NOW())
        OR (status IN ('preparing', 'running', 'collecting_artifacts') AND lease_until <= NOW())
      )
    ORDER BY next_attempt_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2), 1), 20)
  )
  UPDATE sandbox_runs AS runs
  SET status = 'preparing',
      attempts = runs.attempts + 1,
      worker_id = p_worker_id,
      lease_token = gen_random_uuid()::TEXT,
      lease_until = NOW() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 1800)),
      updated_at = NOW()
  FROM claimable
  WHERE runs.id = claimable.id
  RETURNING runs.*;
END;
$$;

CREATE OR REPLACE FUNCTION heartbeat_sandbox_run(
  p_run_id TEXT,
  p_worker_id TEXT,
  p_lease_token TEXT,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH renewed AS (
    UPDATE sandbox_runs
    SET lease_until = NOW() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 1800)),
        updated_at = NOW()
    WHERE id = p_run_id
      AND worker_id = p_worker_id
      AND lease_token = p_lease_token
      AND status IN ('preparing', 'running', 'collecting_artifacts')
      AND lease_until > NOW()
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM renewed);
$$;

CREATE OR REPLACE FUNCTION append_sandbox_event(
  p_run_id TEXT,
  p_type TEXT,
  p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS sandbox_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted sandbox_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_run_id, 0));
  INSERT INTO sandbox_events (run_id, sequence, type, payload)
  SELECT p_run_id, COALESCE(MAX(sequence), 0) + 1, p_type, COALESCE(p_payload, '{}'::JSONB)
  FROM sandbox_events
  WHERE run_id = p_run_id
  RETURNING * INTO inserted;
  RETURN inserted;
END;
$$;

ALTER TABLE sandbox_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_approval_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own sandbox runs" ON sandbox_runs;
CREATE POLICY "users read own sandbox runs" ON sandbox_runs
  FOR SELECT USING (auth.uid()::TEXT = user_id);
DROP POLICY IF EXISTS "users read own sandbox events" ON sandbox_events;
CREATE POLICY "users read own sandbox events" ON sandbox_events
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM sandbox_runs WHERE sandbox_runs.id = sandbox_events.run_id
      AND sandbox_runs.user_id = auth.uid()::TEXT
  ));
DROP POLICY IF EXISTS "users read own sandbox artifacts" ON sandbox_artifacts;
CREATE POLICY "users read own sandbox artifacts" ON sandbox_artifacts
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM sandbox_runs WHERE sandbox_runs.id = sandbox_artifacts.run_id
      AND sandbox_runs.user_id = auth.uid()::TEXT
  ));

REVOKE ALL ON FUNCTION claim_sandbox_runs(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_sandbox_run(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_sandbox_event(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_sandbox_skill(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sandbox_runs(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION heartbeat_sandbox_run(TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION append_sandbox_event(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION upsert_sandbox_skill(TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION publish_sandbox_skill_version(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION delete_sandbox_skill(TEXT, TEXT) TO service_role;

COMMIT;
