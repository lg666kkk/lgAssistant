-- User-owned LLM providers, models, and routing preferences.

CREATE TABLE IF NOT EXISTS user_llm_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_key_hint TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_llm_providers_adapter_check
    CHECK (adapter_type IN ('openai-compatible')),
  CONSTRAINT user_llm_providers_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT user_llm_providers_base_url_length CHECK (char_length(base_url) BETWEEN 8 AND 500),
  CONSTRAINT user_llm_providers_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT user_llm_providers_user_name_unique UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS user_llm_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 32000,
  max_output_tokens INTEGER NOT NULL DEFAULT 4096,
  temperature DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  supports_tools BOOLEAN NOT NULL DEFAULT TRUE,
  supports_images BOOLEAN NOT NULL DEFAULT FALSE,
  reasoning_mode TEXT NOT NULL DEFAULT 'none',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_llm_models_reasoning_check CHECK (reasoning_mode IN ('none', 'deepseek')),
  CONSTRAINT user_llm_models_model_id_length CHECK (char_length(model_id) BETWEEN 1 AND 180),
  CONSTRAINT user_llm_models_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT user_llm_models_context_window_check CHECK (context_window BETWEEN 4096 AND 2000000),
  CONSTRAINT user_llm_models_output_tokens_check CHECK (max_output_tokens BETWEEN 64 AND 131072),
  CONSTRAINT user_llm_models_temperature_check CHECK (temperature BETWEEN 0 AND 2),
  CONSTRAINT user_llm_models_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT user_llm_models_provider_owner_fk
    FOREIGN KEY (provider_id, user_id) REFERENCES user_llm_providers(id, user_id) ON DELETE CASCADE,
  CONSTRAINT user_llm_models_provider_model_unique UNIQUE (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS user_llm_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_model_id UUID REFERENCES user_llm_models(id) ON DELETE SET NULL,
  fast_model_id UUID REFERENCES user_llm_models(id) ON DELETE SET NULL,
  vision_model_id UUID REFERENCES user_llm_models(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_llm_config_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_llm_config_audit_action_check
    CHECK (action IN ('provider_create', 'provider_update', 'provider_delete', 'preferences_update', 'connection_test', 'models_discover'))
);

CREATE INDEX IF NOT EXISTS user_llm_providers_user_updated_idx
  ON user_llm_providers(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS user_llm_models_user_provider_idx
  ON user_llm_models(user_id, provider_id, updated_at DESC);

ALTER TABLE user_llm_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_llm_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_llm_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_llm_config_audit ENABLE ROW LEVEL SECURITY;

-- Provider rows contain encrypted secrets. Browser clients must not download even their
-- own ciphertext; all access goes through authenticated server routes that filter user_id.
REVOKE ALL ON TABLE user_llm_providers FROM anon, authenticated;
REVOKE ALL ON TABLE user_llm_models FROM anon, authenticated;
REVOKE ALL ON TABLE user_llm_preferences FROM anon, authenticated;
REVOKE ALL ON TABLE user_llm_config_audit FROM anon, authenticated;
