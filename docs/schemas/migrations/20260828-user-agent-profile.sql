-- User-maintained, stable profile injected into the agent prompt.

CREATE TABLE IF NOT EXISTS user_agent_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_agent_profiles_content_length CHECK (char_length(content) <= 8000)
);

ALTER TABLE user_agent_profiles ENABLE ROW LEVEL SECURITY;

-- All reads and writes go through authenticated server routes using service_role.
REVOKE ALL ON TABLE user_agent_profiles FROM anon, authenticated;

COMMENT ON TABLE user_agent_profiles IS 'User-maintained stable profile, exposed as a USER.md-style editor';
COMMENT ON COLUMN user_agent_profiles.content IS 'Markdown profile injected into chat prompts and copied into redacted trace records';
