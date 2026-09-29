ALTER TABLE public.sandbox_runs
  ADD COLUMN IF NOT EXISTS execution_log JSONB NOT NULL DEFAULT '[]'::JSONB;
