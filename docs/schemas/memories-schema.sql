-- ============================================
-- 分层记忆 - 长期记忆表（能力2）
-- 一行 = 一条长期记忆（用户偏好、成功模式等）
-- 对应接口：lib/agent/memory/types.ts 的 MemoryStore
-- ============================================

CREATE TABLE IF NOT EXISTS agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 业务 key：set(key)/get(key) 配对用。同一用户内唯一。
  key TEXT NOT NULL,
  -- layer：长期表当前恒为 'longterm'，但保留列以支持「多层共用一张表」（见决策2）
  layer TEXT NOT NULL DEFAULT 'longterm',
  content TEXT NOT NULL,                      -- 记忆正文
  metadata JSONB NOT NULL DEFAULT '{}',       -- user_id、来源等灵活字段
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()        -- upsert 覆盖时更新（见决策3）
);

ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_user_key_unique_idx ON agent_memories (user_id, key);
CREATE INDEX IF NOT EXISTS agent_memories_layer_idx ON agent_memories (layer);
CREATE INDEX IF NOT EXISTS agent_memories_user_id_layer_idx ON agent_memories (user_id, layer);
CREATE INDEX IF NOT EXISTS agent_memories_created_at_idx ON agent_memories (created_at);
