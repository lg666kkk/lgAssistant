-- Current-user knowledge source connections. Credentials are encrypted by the server.

CREATE TABLE IF NOT EXISTS user_knowledge_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
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
  CONSTRAINT user_knowledge_connections_provider_check CHECK (provider IN ('notion')),
  CONSTRAINT user_knowledge_connections_user_provider_unique UNIQUE (user_id, provider)
);

ALTER TABLE user_knowledge_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_knowledge_connections FROM anon, authenticated;

COMMENT ON TABLE user_knowledge_connections IS 'Per-user knowledge source credentials and connector settings';
COMMENT ON COLUMN user_knowledge_connections.credentials_ciphertext IS 'AES-256-GCM encrypted connector credential';
