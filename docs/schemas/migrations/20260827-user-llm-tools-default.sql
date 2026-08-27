-- Normalize models created by the earlier discovery UI, which defaulted tool support to false.
-- This is a one-time data migration; users can still disable tool calling afterwards.

UPDATE user_llm_models
SET supports_tools = TRUE,
    updated_at = NOW()
WHERE supports_tools = FALSE;
