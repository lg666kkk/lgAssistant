-- Persist the latest server-estimated context usage for each chat session.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
