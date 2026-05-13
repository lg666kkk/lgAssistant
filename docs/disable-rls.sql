-- ============================================
-- 配置 Row Level Security (RLS) 策略
-- ============================================

-- 1. 启用 RLS
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 2. 删除旧策略（如果存在）
DROP POLICY IF EXISTS "允许所有操作 sessions" ON sessions;
DROP POLICY IF EXISTS "允许所有操作 messages" ON messages;

-- 3. 创建新策略：允许所有操作（适用于个人项目）
-- 注意：生产环境应该根据用户身份限制访问

-- sessions 表策略
CREATE POLICY "允许查询所有会话"
  ON sessions FOR SELECT
  USING (true);

CREATE POLICY "允许插入会话"
  ON sessions FOR INSERT
  WITH CHECK (true);

CREATE POLICY "允许更新会话"
  ON sessions FOR UPDATE
  USING (true);

CREATE POLICY "允许删除会话"
  ON sessions FOR DELETE
  USING (true);

-- messages 表策略
CREATE POLICY "允许查询所有消息"
  ON messages FOR SELECT
  USING (true);

CREATE POLICY "允许插入消息"
  ON messages FOR INSERT
  WITH CHECK (true);

CREATE POLICY "允许更新消息"
  ON messages FOR UPDATE
  USING (true);

CREATE POLICY "允许删除消息"
  ON messages FOR DELETE
  USING (true);

