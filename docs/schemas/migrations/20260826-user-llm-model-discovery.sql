-- Allow model-list discovery events for installations that already applied the
-- initial user LLM configuration migration.

ALTER TABLE user_llm_config_audit
  DROP CONSTRAINT IF EXISTS user_llm_config_audit_action_check;

ALTER TABLE user_llm_config_audit
  ADD CONSTRAINT user_llm_config_audit_action_check
  CHECK (action IN (
    'provider_create',
    'provider_update',
    'provider_delete',
    'preferences_update',
    'connection_test',
    'models_discover'
  ));

