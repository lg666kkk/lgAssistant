-- User-owned E2B credentials. Only server-side service-role access is allowed.

CREATE TABLE IF NOT EXISTS user_sandbox_configs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key_ciphertext TEXT NOT NULL,
  api_key_hint TEXT NOT NULL DEFAULT '',
  last_tested_at TIMESTAMPTZ,
  last_test_status TEXT CHECK (last_test_status IS NULL OR last_test_status IN ('ok', 'error')),
  last_test_latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sandbox_config_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('config_update', 'connection_test')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_sandbox_config_audit_user_created_idx
  ON user_sandbox_config_audit(user_id, created_at DESC);

ALTER TABLE user_sandbox_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sandbox_config_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_sandbox_configs FROM anon, authenticated;
REVOKE ALL ON TABLE user_sandbox_config_audit FROM anon, authenticated;
