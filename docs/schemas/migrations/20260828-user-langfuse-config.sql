-- User-owned Langfuse configuration. Ciphertext is never exposed to browser roles.

CREATE TABLE IF NOT EXISTS user_langfuse_config (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  base_url TEXT NOT NULL DEFAULT 'https://cloud.langfuse.com',
  public_key_ciphertext TEXT NOT NULL DEFAULT '',
  public_key_hint TEXT NOT NULL DEFAULT '',
  secret_key_ciphertext TEXT NOT NULL DEFAULT '',
  secret_key_hint TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_langfuse_base_url_length CHECK (char_length(base_url) BETWEEN 8 AND 500)
);

ALTER TABLE user_langfuse_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_langfuse_config FROM anon, authenticated;
