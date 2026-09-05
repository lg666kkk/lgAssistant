-- Reliable scheduler claims and encrypted per-user outbound notification channels.

ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_until BIGINT;

CREATE INDEX IF NOT EXISTS scheduled_jobs_due_claim_idx
  ON scheduled_jobs (enabled, next_run_at, lease_until);

CREATE TABLE IF NOT EXISTS user_notification_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'wecom')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  credentials_ciphertext TEXT NOT NULL DEFAULT '',
  credentials_hint TEXT NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_test_status TEXT CHECK (last_test_status IN ('success', 'failed')),
  last_test_error TEXT,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_notification_channels_user_provider_unique UNIQUE (user_id, provider)
);

ALTER TABLE user_notification_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_notification_channels FROM anon, authenticated;

ALTER TABLE scheduled_job_runs
  DROP CONSTRAINT IF EXISTS scheduled_job_runs_status_check;
ALTER TABLE scheduled_job_runs
  ADD CONSTRAINT scheduled_job_runs_status_check
  CHECK (status IN ('running', 'success', 'failed', 'skipped'));
ALTER TABLE scheduled_job_runs
  ADD COLUMN IF NOT EXISTS scheduled_for BIGINT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_id TEXT;

CREATE TABLE IF NOT EXISTS scheduled_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id BIGINT NOT NULL REFERENCES scheduled_job_runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'wecom')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'delivered', 'retry_wait', 'dead')),
  text TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at BIGINT NOT NULL,
  provider_message_id TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_until BIGINT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scheduled_deliveries_due_idx
  ON scheduled_deliveries (status, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS scheduled_deliveries_user_created_idx
  ON scheduled_deliveries (user_id, created_at DESC);

ALTER TABLE scheduled_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE scheduled_deliveries FROM anon, authenticated;

CREATE OR REPLACE FUNCTION claim_due_scheduled_jobs(
  p_now BIGINT,
  p_worker_id TEXT,
  p_lease_ms BIGINT DEFAULT 300000,
  p_limit INTEGER DEFAULT 10
)
RETURNS SETOF scheduled_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT candidate.id
    FROM scheduled_jobs AS candidate
    WHERE candidate.enabled = TRUE
      AND candidate.next_run_at <= p_now
      AND (candidate.lease_until IS NULL OR candidate.lease_until < p_now)
    ORDER BY candidate.next_run_at ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE scheduled_jobs AS job
  SET lease_owner = p_worker_id,
      lease_until = p_now + GREATEST(p_lease_ms, 60000),
      updated_at = NOW()
  FROM due
  WHERE job.id = due.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION claim_due_scheduled_jobs(BIGINT, TEXT, BIGINT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_due_scheduled_jobs(BIGINT, TEXT, BIGINT, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION claim_scheduled_job_now(
  p_job_id TEXT,
  p_user_id TEXT,
  p_now BIGINT,
  p_worker_id TEXT,
  p_lease_ms BIGINT DEFAULT 300000
)
RETURNS SETOF scheduled_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE scheduled_jobs AS job
  SET lease_owner = p_worker_id,
      lease_until = p_now + GREATEST(p_lease_ms, 60000),
      updated_at = NOW()
  WHERE job.id = p_job_id
    AND job.user_id = p_user_id
    AND (job.lease_until IS NULL OR job.lease_until < p_now)
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION claim_scheduled_job_now(TEXT, TEXT, BIGINT, TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_scheduled_job_now(TEXT, TEXT, BIGINT, TEXT, BIGINT)
  TO service_role;

CREATE OR REPLACE FUNCTION claim_due_scheduled_deliveries(
  p_now BIGINT,
  p_worker_id TEXT,
  p_lease_ms BIGINT DEFAULT 60000,
  p_limit INTEGER DEFAULT 20
)
RETURNS SETOF scheduled_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT candidate.id
    FROM scheduled_deliveries AS candidate
    WHERE candidate.status IN ('pending', 'retry_wait', 'sending')
      AND candidate.next_attempt_at <= p_now
      AND (candidate.lease_until IS NULL OR candidate.lease_until < p_now)
    ORDER BY candidate.next_attempt_at ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE scheduled_deliveries AS delivery
  SET status = 'sending',
      attempt_count = delivery.attempt_count + 1,
      lease_owner = p_worker_id,
      lease_until = p_now + GREATEST(p_lease_ms, 30000),
      updated_at = NOW()
  FROM due
  WHERE delivery.id = due.id
  RETURNING delivery.*;
END;
$$;

REVOKE ALL ON FUNCTION claim_due_scheduled_deliveries(BIGINT, TEXT, BIGINT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_due_scheduled_deliveries(BIGINT, TEXT, BIGINT, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION finalize_scheduled_job_run(
  p_run_id BIGINT,
  p_job_id TEXT,
  p_worker_id TEXT,
  p_status TEXT,
  p_result TEXT,
  p_error TEXT,
  p_metadata JSONB,
  p_providers TEXT[],
  p_next_run_at BIGINT,
  p_disable BOOLEAN,
  p_finished_at BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('success', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'unsupported scheduler run status: %', p_status;
  END IF;

  UPDATE scheduled_job_runs
  SET status = p_status,
      result = p_result,
      error = LEFT(p_error, 4000),
      metadata = COALESCE(p_metadata, '{}'::jsonb),
      finished_at = TO_TIMESTAMP(p_finished_at / 1000.0)
  WHERE id = p_run_id
    AND job_id = p_job_id
    AND worker_id = p_worker_id
    AND status = 'running';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduler run is missing or already finalized';
  END IF;

  UPDATE scheduled_jobs
  SET last_run_at = CASE WHEN p_status = 'skipped' THEN last_run_at ELSE p_finished_at END,
      last_error = CASE WHEN p_status = 'failed' THEN LEFT(p_error, 4000) ELSE NULL END,
      last_result = CASE WHEN p_status = 'success' THEN LEFT(p_result, 4000) ELSE last_result END,
      next_run_at = COALESCE(p_next_run_at, next_run_at),
      enabled = CASE WHEN p_disable THEN FALSE ELSE enabled END,
      lease_owner = NULL,
      lease_until = NULL,
      updated_at = NOW()
  WHERE id = p_job_id
    AND lease_owner = p_worker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduler job lease is missing or owned by another worker';
  END IF;

  IF p_status = 'success' THEN
    INSERT INTO scheduled_deliveries (
      run_id,
      job_id,
      user_id,
      provider,
      status,
      text,
      attempt_count,
      max_attempts,
      next_attempt_at,
      idempotency_key
    )
    SELECT
      p_run_id,
      job.id,
      job.user_id::UUID,
      selected.provider,
      'pending',
      COALESCE(NULLIF(p_result, ''), '定时任务已执行完成。'),
      0,
      5,
      p_finished_at,
      p_run_id::TEXT || ':' || selected.provider
    FROM scheduled_jobs AS job
    CROSS JOIN UNNEST(COALESCE(p_providers, ARRAY[]::TEXT[])) AS selected(provider)
    WHERE job.id = p_job_id
      AND selected.provider IN ('telegram', 'wecom')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION finalize_scheduled_job_run(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], BIGINT, BOOLEAN, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_scheduled_job_run(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], BIGINT, BOOLEAN, BIGINT)
  TO service_role;

COMMENT ON TABLE user_notification_channels IS
  'Encrypted per-user Telegram and WeCom outbound notification configuration';
COMMENT ON TABLE scheduled_deliveries IS
  'Retryable outbound delivery records separated from agent execution';
