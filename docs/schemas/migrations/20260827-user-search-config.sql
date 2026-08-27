-- User-owned web search providers and default routing.

CREATE TABLE IF NOT EXISTS user_search_providers (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  api_key_hint TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT user_search_provider_check CHECK (provider IN ('tavily', 'exa', 'brave'))
);

CREATE TABLE IF NOT EXISTS user_search_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_provider TEXT NOT NULL DEFAULT 'tavily',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_search_default_provider_check CHECK (default_provider IN ('tavily', 'exa', 'brave'))
);

ALTER TABLE user_search_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_search_preferences ENABLE ROW LEVEL SECURITY;

-- Search credentials are decrypted only in authenticated server routes/tools.
REVOKE ALL ON TABLE user_search_providers FROM anon, authenticated;
REVOKE ALL ON TABLE user_search_preferences FROM anon, authenticated;
