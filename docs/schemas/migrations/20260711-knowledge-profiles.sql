-- Persist compressed knowledge profiles generated from compiled wiki summaries.

CREATE TABLE IF NOT EXISTS knowledge_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_type TEXT NOT NULL DEFAULT 'search_notes_tool',
  source_hash TEXT NOT NULL,
  profile TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, profile_type)
);

ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS profile_type TEXT NOT NULL DEFAULT 'search_notes_tool';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS source_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_profiles_user_type_unique_idx
ON knowledge_profiles (user_id, profile_type);

CREATE INDEX IF NOT EXISTS knowledge_profiles_updated_idx
ON knowledge_profiles (user_id, updated_at DESC);

ALTER TABLE knowledge_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "用户只能访问自己的 knowledge_profiles" ON knowledge_profiles;

CREATE POLICY "用户只能访问自己的 knowledge_profiles"
  ON knowledge_profiles FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE knowledge_profiles IS '个人知识库画像缓存，用于工具描述和路由提示';
