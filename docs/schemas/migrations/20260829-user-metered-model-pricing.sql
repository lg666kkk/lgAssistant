-- User-specific input pricing for Embedding and Rerank models.
-- Unit: CNY per one million input tokens.

CREATE TABLE IF NOT EXISTS user_metered_model_pricing (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_price_cny NUMERIC(14, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category, model_id),
  CONSTRAINT user_metered_model_pricing_category_check
    CHECK (category IN ('embedding', 'rerank')),
  CONSTRAINT user_metered_model_pricing_model_length
    CHECK (char_length(model_id) BETWEEN 1 AND 180),
  CONSTRAINT user_metered_model_pricing_value_check
    CHECK (input_price_cny >= 0)
);

ALTER TABLE user_metered_model_pricing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_metered_model_pricing FROM anon, authenticated;

