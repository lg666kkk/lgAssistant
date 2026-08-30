-- Per-model pricing used for trace-time cost snapshots and usage aggregation.
-- Unit: CNY per one million tokens. NULL means unknown, not free.

ALTER TABLE user_llm_models
  ADD COLUMN IF NOT EXISTS input_cache_hit_price_cny NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS input_cache_miss_price_cny NUMERIC(14, 6),
  ADD COLUMN IF NOT EXISTS output_price_cny NUMERIC(14, 6);

ALTER TABLE user_llm_models
  DROP CONSTRAINT IF EXISTS user_llm_models_pricing_complete_check,
  ADD CONSTRAINT user_llm_models_pricing_complete_check CHECK (
    (
      input_cache_hit_price_cny IS NULL
      AND input_cache_miss_price_cny IS NULL
      AND output_price_cny IS NULL
    ) OR (
      input_cache_hit_price_cny >= 0
      AND input_cache_miss_price_cny >= 0
      AND output_price_cny >= 0
    )
  );

