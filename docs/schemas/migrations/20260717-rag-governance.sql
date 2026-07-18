BEGIN;

ALTER TABLE agent_traces
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;

UPDATE agent_traces
SET retention_until = COALESCE(retention_until, created_at + INTERVAL '30 days');

ALTER TABLE agent_traces
  ALTER COLUMN retention_until SET DEFAULT (NOW() + INTERVAL '30 days');

CREATE INDEX IF NOT EXISTS agent_traces_retention_until_idx
  ON agent_traces (retention_until);

CREATE OR REPLACE FUNCTION purge_expired_agent_traces()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM agent_traces
  WHERE retention_until IS NOT NULL
    AND retention_until <= NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_agent_traces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_agent_traces() TO service_role;

COMMIT;
