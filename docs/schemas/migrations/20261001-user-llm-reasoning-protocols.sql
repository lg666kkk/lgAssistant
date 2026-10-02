-- Extend thinking protocols without changing existing model selections.
BEGIN;
ALTER TABLE user_llm_models DROP CONSTRAINT IF EXISTS user_llm_models_reasoning_check;
ALTER TABLE user_llm_models ADD CONSTRAINT user_llm_models_reasoning_check
  CHECK (reasoning_mode IN ('none', 'auto-on', 'auto-off', 'deepseek', 'deepseek-off', 'qwen', 'qwen-off', 'thinking', 'thinking-off'));
COMMIT;
