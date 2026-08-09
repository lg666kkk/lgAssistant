-- Add a reversible user override without replacing the generated knowledge profile.

ALTER TABLE knowledge_profiles
  ADD COLUMN IF NOT EXISTS custom_profile TEXT;

ALTER TABLE knowledge_profiles
  ADD COLUMN IF NOT EXISTS custom_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_profiles_custom_profile_length_check'
  ) THEN
    ALTER TABLE knowledge_profiles
      ADD CONSTRAINT knowledge_profiles_custom_profile_length_check
      CHECK (custom_profile IS NULL OR char_length(custom_profile) <= 320);
  END IF;
END $$;

COMMENT ON COLUMN knowledge_profiles.profile IS
  '系统根据已编译知识页自动生成的画像';

COMMENT ON COLUMN knowledge_profiles.custom_profile IS
  '用户自定义覆盖层；非空时优先于系统画像，清空后恢复自动画像';
