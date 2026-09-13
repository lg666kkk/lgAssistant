-- User-owned MCP connections. All access goes through authenticated server routes.
CREATE TABLE IF NOT EXISTS user_mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url TEXT NOT NULL CHECK (char_length(url) <= 2048),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  token_ciphertext TEXT NOT NULL DEFAULT '',
  tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_mcp_servers_user_idx ON user_mcp_servers (user_id);
ALTER TABLE user_mcp_servers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_mcp_servers FROM anon, authenticated;
COMMENT ON TABLE user_mcp_servers IS 'User MCP endpoints and allowlisted tools; credentials encrypted with AES-256-GCM';
