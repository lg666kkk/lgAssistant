CREATE TABLE IF NOT EXISTS user_memory_config (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  recall_limit INTEGER NOT NULL DEFAULT 3 CHECK (recall_limit BETWEEN 1 AND 10),
  recall_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.68 CHECK (recall_threshold BETWEEN 0 AND 1),
  write_confidence DOUBLE PRECISION NOT NULL DEFAULT 0.72 CHECK (write_confidence BETWEEN 0 AND 1),
  ambiguous_candidate_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.85 CHECK (ambiguous_candidate_threshold BETWEEN 0 AND 1),
  keyword_admit_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (keyword_admit_threshold BETWEEN 0 AND 1),
  fusion_strategy TEXT NOT NULL DEFAULT 'weighted' CHECK (fusion_strategy IN ('vector_only', 'weighted', 'rrf')),
  rerank_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rerank_mode TEXT NOT NULL DEFAULT 'always' CHECK (rerank_mode IN ('always', 'conditional')),
  rerank_model TEXT NOT NULL DEFAULT 'qwen3-rerank',
  rerank_url TEXT NOT NULL DEFAULT '',
  rerank_api_key_ciphertext TEXT NOT NULL DEFAULT '',
  rerank_api_key_hint TEXT NOT NULL DEFAULT '',
  rerank_instruct TEXT NOT NULL DEFAULT 'Given a user memory retrieval query, retrieve relevant personal memory passages that answer the query.',
  rerank_candidate_count INTEGER NOT NULL DEFAULT 12 CHECK (rerank_candidate_count BETWEEN 2 AND 24),
  rerank_admit_threshold DOUBLE PRECISION CHECK (rerank_admit_threshold BETWEEN 0 AND 1),
  rerank_timeout_ms INTEGER NOT NULL DEFAULT 1200 CHECK (rerank_timeout_ms BETWEEN 200 AND 8000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_memory_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE user_memory_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE user_memory_config FROM anon, authenticated;
