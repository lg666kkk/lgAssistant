-- ============================================
-- Row Level Security (RLS) 策略
-- 历史文件名叫 disable-rls.sql，但当前内容已经改为用户隔离策略。
-- ============================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE compiled_wiki_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE compiled_wiki_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_semantic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE leetcode_daily_practices ENABLE ROW LEVEL SECURITY;
ALTER TABLE leetcode_wrong_problems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "允许所有操作 sessions" ON sessions;
DROP POLICY IF EXISTS "允许所有操作 messages" ON messages;
DROP POLICY IF EXISTS "用户只能访问自己的 sessions" ON sessions;
DROP POLICY IF EXISTS "用户只能访问自己的 messages" ON messages;
DROP POLICY IF EXISTS "用户只能访问自己的 agent_traces" ON agent_traces;
DROP POLICY IF EXISTS "用户只能访问自己的 notion_pages" ON notion_pages;
DROP POLICY IF EXISTS "用户只能访问自己的 documents" ON documents;
DROP POLICY IF EXISTS "用户只能访问自己的 compiled_wiki_pages" ON compiled_wiki_pages;
DROP POLICY IF EXISTS "用户只能访问自己的 compiled_wiki_edges" ON compiled_wiki_edges;
DROP POLICY IF EXISTS "用户只能访问自己的 agent_memories" ON agent_memories;
DROP POLICY IF EXISTS "用户只能访问自己的 agent_semantic_memories" ON agent_semantic_memories;
DROP POLICY IF EXISTS "用户只能访问自己的 leetcode_daily_practices" ON leetcode_daily_practices;
DROP POLICY IF EXISTS "用户只能访问自己的 leetcode_wrong_problems" ON leetcode_wrong_problems;

CREATE POLICY "用户只能访问自己的 sessions"
  ON sessions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 messages"
  ON messages FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 agent_traces"
  ON agent_traces FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 notion_pages"
  ON notion_pages FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 documents"
  ON documents FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 compiled_wiki_pages"
  ON compiled_wiki_pages FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 compiled_wiki_edges"
  ON compiled_wiki_edges FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 agent_memories"
  ON agent_memories FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 agent_semantic_memories"
  ON agent_semantic_memories FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 leetcode_daily_practices"
  ON leetcode_daily_practices FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的 leetcode_wrong_problems"
  ON leetcode_wrong_problems FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
