-- Runtime configuration control plane. All application access uses the
-- service-role client; no browser role receives direct table privileges.

CREATE TABLE IF NOT EXISTS app_runtime_config (
  scope TEXT NOT NULL DEFAULT 'global',
  key TEXT NOT NULL,
  value_ciphertext TEXT NOT NULL,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key),
  CONSTRAINT app_runtime_config_scope_check CHECK (scope = 'global'),
  CONSTRAINT app_runtime_config_key_check CHECK (key ~ '^[A-Z][A-Z0-9_]{1,127}$')
);

CREATE TABLE IF NOT EXISTS app_runtime_config_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL DEFAULT 'global',
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  value_digest TEXT,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_runtime_config_audit_scope_check CHECK (scope = 'global'),
  CONSTRAINT app_runtime_config_audit_action_check CHECK (action IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS app_runtime_config_audit_key_created_idx
  ON app_runtime_config_audit (key, created_at DESC);

ALTER TABLE app_runtime_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_runtime_config_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_runtime_config FROM anon, authenticated;
REVOKE ALL ON TABLE app_runtime_config_audit FROM anon, authenticated;
