-- Live progress is separate from the published document index.
ALTER TABLE knowledge_file_generations
  ADD COLUMN IF NOT EXISTS progress jsonb;
