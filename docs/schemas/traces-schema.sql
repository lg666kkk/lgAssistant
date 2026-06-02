-- ============================================
-- Agent 运行 Trace 表（可观测性 能力3）
-- 一行 = 一次 runAgentLoop 的完整执行轨迹
-- ============================================

CREATE TABLE IF NOT EXISTS agent_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  -- session_id 可空：当前前端还没传 sessionId，未来关联会话用
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  stop_reason TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  total_duration_ms INTEGER DEFAULT NULL,
  steps JSONB NOT NULL DEFAULT '[]',     -- TraceStep[] 整体序列化
  metrics JSONB NOT NULL DEFAULT '{}',   -- AgentLoopMetrics 聚合
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_traces_request_id_idx ON agent_traces (request_id);
CREATE INDEX IF NOT EXISTS agent_traces_session_id_idx ON agent_traces (session_id);
CREATE INDEX IF NOT EXISTS agent_traces_created_at_idx ON agent_traces (created_at);
