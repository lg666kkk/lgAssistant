-- User-owned Embedding connection used by memory and knowledge RAG.

CREATE TABLE IF NOT EXISTS user_embedding_configs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'dashscope',
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_key_hint TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT 'text-embedding-v4',
  dimensions INTEGER NOT NULL DEFAULT 1024,
  last_tested_at TIMESTAMPTZ,
  last_test_status TEXT,
  last_test_latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_embedding_provider_check
    CHECK (provider IN ('dashscope', 'openai-compatible')),
  CONSTRAINT user_embedding_model_check
    CHECK (model_id = 'text-embedding-v4'),
  CONSTRAINT user_embedding_dimensions_check
    CHECK (dimensions = 1024),
  CONSTRAINT user_embedding_test_status_check
    CHECK (last_test_status IS NULL OR last_test_status IN ('ok', 'error')),
  CONSTRAINT user_embedding_base_url_length
    CHECK (char_length(base_url) BETWEEN 8 AND 500)
);

CREATE TABLE IF NOT EXISTS user_embedding_config_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_embedding_audit_action_check
    CHECK (action IN ('config_update', 'connection_test'))
);

CREATE INDEX IF NOT EXISTS user_embedding_config_audit_user_created_idx
  ON user_embedding_config_audit(user_id, created_at DESC);

ALTER TABLE user_embedding_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_embedding_config_audit ENABLE ROW LEVEL SECURITY;

-- Ciphertext is only handled by authenticated server routes using service-role.
REVOKE ALL ON TABLE user_embedding_configs FROM anon, authenticated;
REVOKE ALL ON TABLE user_embedding_config_audit FROM anon, authenticated;

