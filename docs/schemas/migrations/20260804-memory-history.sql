-- 记忆双时态归档 + 并发保护 + 用户授权硬删除
--
-- 背景：agent_memories 的 (user_id, key) 是 UNIQUE，UPDATE 路径直接覆盖旧值，
-- 旧值不可恢复。误抽取（DEFAULT_WRITE_CONFIDENCE = 0.72 是阈值，不是正确性保证）
-- 一旦发生就永久丢数据。本迁移把旧值在同事务归档到独立历史表。
--
-- 三个刻意的取舍：
--   1. 历史表不带 embedding、不进 HNSW。match_memories 里的 status = 'active'
--      是**后置**过滤，pgvector 的 HNSW 先取近邻再过滤，历史版本进向量表会挤占
--      match_count 名额，导致当前值召回条数变少甚至召不回（filtered-ANN 问题）。
--   2. 当前表继续用 valid_from / valid_to，只有新建的历史表用双时态命名。
--      改当前表的列名要动 atomic-writer 和所有 RPC，收益为零。
--   3. 保留期清理（memory:history:cleanup）与 purge_memory 是两件事：
--      前者是运维「时间到了自动清」，后者是隐私「用户现在要求清」，不能互相替代。

-- ============================================================
-- ① version 列：乐观并发校验的基础
-- ============================================================
-- FOR UPDATE 只保证「不同时写」，不保证「后写的那个知道自己在覆盖什么」。
-- 调用方读候选时记下 version，写入时回传 p_expected_version，不匹配抛 40001。
ALTER TABLE agent_memories
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_semantic_memories
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- ② 历史表
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_memory_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,

  -- ── 有效时间轴（现实世界里这个事实何时为真）─────────────
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ NOT NULL,   -- correction 时等于 effective_from（从未为真）

  -- ── 记录时间轴（系统何时知道 / 何时不再采信）───────────
  -- recorded_at 存的是**旧行原本的 created_at**，不是归档时刻。
  -- 归档时刻是 superseded_at。写错这一列，记录轴就废了。
  recorded_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── 旧行完整快照（审计与恢复都需要，不能只留 content）──
  -- 只留 content 的话：审计答不了「当时这条是 user_explicit 还是 inferred、
  -- confidence 多少」，而误抽取排查恰恰依赖这两个字段；恢复时缺 source /
  -- confidence / importance / evidence，只能靠默认值重建，等于二次失真。
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  importance DOUBLE PRECISION NOT NULL,
  -- 归档瞬间旧行的 status：可能是 active（正常演变），也可能是 invalidated
  -- （用户重新确认了已失效的事实），两者历史语义不同。
  status TEXT NOT NULL,
  evidence JSONB,
  metadata JSONB,
  version INTEGER NOT NULL,

  -- ── 归因 ────────────────────────────────────────────
  superseded_by_request_id TEXT,
  supersede_kind TEXT NOT NULL
    CHECK (supersede_kind IN ('evolution', 'correction', 'invalidation')),
  reason TEXT
);

-- 有效轴查询：「某时刻现实中什么为真」
CREATE INDEX IF NOT EXISTS agent_memory_history_user_key_idx
  ON agent_memory_history (user_id, key, effective_to DESC);

-- 记录轴查询：「系统在某时刻认为什么是真的」，走另一个索引
CREATE INDEX IF NOT EXISTS agent_memory_history_user_key_recorded_idx
  ON agent_memory_history (user_id, key, superseded_at DESC);

-- 保留期清理按 memory_type 分档，需要单独的扫描入口
CREATE INDEX IF NOT EXISTS agent_memory_history_type_superseded_idx
  ON agent_memory_history (memory_type, superseded_at);

-- 用户隔离：与 disable-rls.sql 里现有表保持一致。
-- 记忆历史是隐私等级最高的数据，漏掉这段等于对所有已登录用户敞开。
--
-- ⚠️ 但要清楚它**当前拦不住任何东西**：lib/platform/supabase.ts 用的是
-- SUPABASE_SERVICE_ROLE_KEY，service-role 绕过所有 RLS。这段策略是「将来切到
-- anon/authenticated client 或用户直连时的第二道防线」，不是当前的防线。
-- 当前唯一的防线在应用层：两个记忆工具 requiresAuth: true、userId 只从
-- ToolExecutionContext 取（input_schema 里没有 userId 字段）、缺 userId 立即拒绝、
-- 下面每个 RPC 内部都显式 where user_id = p_user_id。
ALTER TABLE agent_memory_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "用户只能访问自己的 agent_memory_history" ON agent_memory_history;
CREATE POLICY "用户只能访问自己的 agent_memory_history"
  ON agent_memory_history FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE agent_memory_history IS
  '被取代的记忆版本。双时态：effective_from/effective_to 是有效轴，recorded_at/superseded_at 是记录轴。不带 embedding，不参与向量召回。';

-- ============================================================
-- ③ 部署陷阱：必须先 DROP 旧签名的 upsert_memory
-- ============================================================
-- upsert_memory 现有 13 个参数，加 4 个变 17 个。Postgres 按参数列表识别函数，
-- CREATE OR REPLACE 加参数**不是替换，是新建一个重载**，13 参数版本仍然存在。
-- Supabase RPC 走命名参数调用，数据库拿到两个候选函数会报
--   PGRST203: Could not choose the best candidate function between ...
-- → 记忆写入全线失败，且报错信息与「归档」毫无关系，排查成本很高。
DROP FUNCTION IF EXISTS upsert_memory(
  UUID, TEXT, TEXT, VECTOR(1024), JSONB, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS invalidate_memory(UUID, TEXT, TIMESTAMPTZ);

-- ============================================================
-- ④ 归档 + 覆盖，同一事务
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_memory(
  p_user_id UUID,
  p_key TEXT,
  p_content TEXT,
  p_embedding VECTOR(1024),
  p_metadata JSONB,
  p_memory_type TEXT,
  p_source TEXT,
  p_confidence DOUBLE PRECISION,
  p_importance DOUBLE PRECISION,
  p_status TEXT,
  p_evidence JSONB,
  p_valid_from TIMESTAMPTZ,
  p_valid_to TIMESTAMPTZ,
  -- 新增 4 个参数：
  -- p_effective_at    该事实所在**用户消息**的时间戳，不是 NOW()
  -- p_supersede_kind  evolution / correction，决定旧行有效期怎么截断
  -- p_expected_version 调用方读候选时看到的 version，NULL 表示不校验
  -- p_request_id      把记忆变更串到 trace，补审计缺口
  p_effective_at TIMESTAMPTZ DEFAULT NULL,
  p_supersede_kind TEXT DEFAULT 'evolution',
  p_expected_version INTEGER DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
)
RETURNS INTEGER          -- 返回写入后的 version，供调用方观测归档链是否连续
LANGUAGE plpgsql
AS $$
DECLARE
  v_version INTEGER;
  v_effective_from TIMESTAMPTZ;
  v_effective_at TIMESTAMPTZ := COALESCE(p_effective_at, p_valid_from, NOW());
  v_kind TEXT := CASE WHEN p_supersede_kind = 'correction' THEN 'correction' ELSE 'evolution' END;
BEGIN
  -- ① 先锁住当前行，防止并发双写各归档一次。
  -- 记忆固化是 fire-and-forget 的（route.ts 的 void consolidate），两个相邻请求
  -- 的固化完全可能重叠执行。无锁时两边 SELECT 到同一份旧行 → 历史表出现两条
  -- 重复归档。行不存在时 FOR UPDATE 不阻塞，正常走下面的 ADD 分支。
  SELECT version, valid_from
    INTO v_version, v_effective_from
  FROM agent_memories
  WHERE user_id = p_user_id AND key = p_key
  FOR UPDATE;

  -- ② 乐观并发校验
  IF v_version IS NOT NULL
     AND p_expected_version IS NOT NULL
     AND v_version <> p_expected_version THEN
    RAISE EXCEPTION 'memory_version_conflict: key=% expected=% actual=%',
      p_key, p_expected_version, v_version
      USING ERRCODE = '40001';   -- serialization_failure，应用层重读候选后重试
  END IF;

  -- ④ 反序保护：p_effective_at 早于当前行的 valid_from，说明这是一个**迟到的
  -- 旧事实**（用户先说 5w 再说 8w，但 5w 那次抽取慢了一步才完成）。
  -- 此时不能覆盖当前行，否则用户看到的是「我明明改成 8w 了」。
  -- 只把它作为一段历史区间插入历史表，当前值保持不动。
  IF v_version IS NOT NULL AND v_effective_at < v_effective_from THEN
    INSERT INTO agent_memory_history (
      user_id, key, effective_from, effective_to, recorded_at, superseded_at,
      content, memory_type, source, confidence, importance, status,
      evidence, metadata, version, superseded_by_request_id, supersede_kind, reason
    ) VALUES (
      p_user_id, p_key, v_effective_at, v_effective_from, NOW(), NOW(),
      p_content, p_memory_type, p_source, p_confidence, p_importance, p_status,
      p_evidence, p_metadata, v_version, p_request_id, 'evolution',
      '迟到的旧事实，只补历史区间，不改当前值'
    );
    RETURN v_version;
  END IF;

  -- ③ 归档旧行完整快照
  IF v_version IS NOT NULL THEN
    INSERT INTO agent_memory_history (
      user_id, key, effective_from, effective_to, recorded_at, superseded_at,
      content, memory_type, source, confidence, importance, status,
      evidence, metadata, version, superseded_by_request_id, supersede_kind, reason
    )
    SELECT
      user_id, key, valid_from,
      CASE WHEN v_kind = 'correction'
           THEN valid_from          -- 从未为真：有效期归零
           ELSE v_effective_at END, -- 演变：到用户表达新值的时刻为止
      -- recorded_at 是旧行原本的 created_at；superseded_at 才是归档时刻。
      -- 处理延迟只影响记录轴，不污染有效轴。
      created_at, NOW(),
      content, memory_type, source, confidence, importance, status,
      evidence, metadata, version, p_request_id, v_kind,
      CASE WHEN v_kind = 'correction' THEN '用户更正了此前记错的事实' ELSE '同一业务键的事实发生变化' END
    FROM agent_memories
    WHERE user_id = p_user_id AND key = p_key;
  END IF;

  -- 长期层：无向量，按业务 key 取
  INSERT INTO agent_memories (
    user_id, key, layer, memory_type, source, confidence, importance, status,
    content, evidence, metadata, valid_from, valid_to, version, updated_at
  ) VALUES (
    p_user_id, p_key, 'longterm', p_memory_type, p_source, p_confidence, p_importance, p_status,
    p_content, p_evidence, p_metadata, p_valid_from, p_valid_to, 1, NOW()
  )
  ON CONFLICT (user_id, key) DO UPDATE SET
    memory_type = EXCLUDED.memory_type,
    source = EXCLUDED.source,
    confidence = EXCLUDED.confidence,
    importance = EXCLUDED.importance,
    status = EXCLUDED.status,
    content = EXCLUDED.content,
    evidence = EXCLUDED.evidence,
    metadata = EXCLUDED.metadata,
    valid_from = EXCLUDED.valid_from,
    valid_to = EXCLUDED.valid_to,
    version = agent_memories.version + 1,
    updated_at = NOW()
  RETURNING version INTO v_version;

  -- 语义层：带向量，按语义召回
  INSERT INTO agent_semantic_memories (
    user_id, key, layer, memory_type, source, confidence, importance, status,
    content, embedding, evidence, metadata, valid_from, valid_to, version, updated_at
  ) VALUES (
    p_user_id, p_key, 'semantic', p_memory_type, p_source, p_confidence, p_importance, p_status,
    p_content, p_embedding, p_evidence, p_metadata, p_valid_from, p_valid_to, 1, NOW()
  )
  ON CONFLICT (user_id, key) DO UPDATE SET
    memory_type = EXCLUDED.memory_type,
    source = EXCLUDED.source,
    confidence = EXCLUDED.confidence,
    importance = EXCLUDED.importance,
    status = EXCLUDED.status,
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    evidence = EXCLUDED.evidence,
    metadata = EXCLUDED.metadata,
    valid_from = EXCLUDED.valid_from,
    valid_to = EXCLUDED.valid_to,
    -- 两层的 version 各自 +1，靠同事务保证同步；不从长期层回填，避免多一次读。
    version = agent_semantic_memories.version + 1,
    updated_at = NOW();

  RETURN v_version;
END;
$$;

COMMENT ON FUNCTION upsert_memory(
  UUID, TEXT, TEXT, VECTOR(1024), JSONB, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ, TEXT, INTEGER, TEXT
) IS '归档旧行到 agent_memory_history 后原子 upsert 两层。带 FOR UPDATE 行锁、expected_version 乐观校验与迟到事实反序保护。';

-- ============================================================
-- ⑤ 软失效也要归档
-- ============================================================
CREATE OR REPLACE FUNCTION invalidate_memory(
  p_user_id UUID,
  p_key TEXT,
  p_valid_to TIMESTAMPTZ,
  p_request_id TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_version INTEGER;
BEGIN
  SELECT version INTO v_version
  FROM agent_memories
  WHERE user_id = p_user_id AND key = p_key AND status = 'active'
  FOR UPDATE;

  IF v_version IS NULL THEN
    RETURN;    -- 没有 active 行可失效，保持原有幂等语义
  END IF;

  -- 否定也要留痕：effective_to 用用户表达失效的时刻，不是 NOW()
  INSERT INTO agent_memory_history (
    user_id, key, effective_from, effective_to, recorded_at, superseded_at,
    content, memory_type, source, confidence, importance, status,
    evidence, metadata, version, superseded_by_request_id, supersede_kind, reason
  )
  SELECT
    user_id, key, valid_from, COALESCE(p_valid_to, NOW()), created_at, NOW(),
    content, memory_type, source, confidence, importance, status,
    evidence, metadata, version, p_request_id, 'invalidation',
    COALESCE(p_reason, '用户要求忘记或否定该事实')
  FROM agent_memories
  WHERE user_id = p_user_id AND key = p_key;

  UPDATE agent_memories
    SET status = 'invalidated', valid_to = p_valid_to,
        version = version + 1, updated_at = NOW()
    WHERE user_id = p_user_id AND key = p_key AND status = 'active';

  UPDATE agent_semantic_memories
    SET status = 'invalidated', valid_to = p_valid_to,
        version = version + 1, updated_at = NOW()
    WHERE user_id = p_user_id AND key = p_key AND status = 'active';
END;
$$;

COMMENT ON FUNCTION invalidate_memory(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT)
IS '原子软失效两层，并把旧行以 supersede_kind = invalidation 归档。';

-- ============================================================
-- ⑥ 用户授权的硬删除
-- ============================================================
-- 引入历史表会制造一个新的隐私缺陷：原本 invalidate_memory 软失效后，
-- 「我住哪里」至少不会再进 prompt；有了历史表 + search_memory_history 工具，
-- 同一条信息又能被翻出来。用户说了「忘记我住哪里」，系统却还留着一条可检索的
-- 记录——这不是保守，是没做到。
--
-- 行业共识里的「不让模型硬删」指的是不让模型自作主张删，不是不允许用户授权删。
-- 混成一件事，就会做出一个删不掉数据的记忆系统。
--
-- 三张表同事务硬删。取代 LongTermStore.forget / SemanticStore.forget 那两个
-- 各自独立 .delete() 的非原子实现（一成一败会造成两层漂移，正是 upsert_memory
-- 当初要解决的问题），且那两个方法不知道历史表的存在。
CREATE OR REPLACE FUNCTION purge_memory(
  p_user_id UUID,
  p_key TEXT
)
RETURNS INTEGER          -- 三张表合计删除行数，供应用层如实告知用户
LANGUAGE plpgsql
AS $$
DECLARE
  v_history INTEGER := 0;
  v_semantic INTEGER := 0;
  v_longterm INTEGER := 0;
BEGIN
  DELETE FROM agent_memory_history WHERE user_id = p_user_id AND key = p_key;
  GET DIAGNOSTICS v_history = ROW_COUNT;

  DELETE FROM agent_semantic_memories WHERE user_id = p_user_id AND key = p_key;
  GET DIAGNOSTICS v_semantic = ROW_COUNT;

  DELETE FROM agent_memories WHERE user_id = p_user_id AND key = p_key;
  GET DIAGNOSTICS v_longterm = ROW_COUNT;

  RETURN v_history + v_semantic + v_longterm;
END;
$$;

COMMENT ON FUNCTION purge_memory(UUID, TEXT)
IS '用户授权的不可逆硬删除：历史表 + 语义层 + 长期层同事务删除。与 memory:history:cleanup 的保留期清理是两件事。';

-- ============================================================
-- ⑦ 历史查询的 key resolver
-- ============================================================
-- 为什么不能复用 match_memories：它写死 status = 'active'，而历史查询的目标
-- 往往正是**已经 invalidated、只剩历史意义**的 key，恰好被过滤掉。
-- 也不能在 agent_memories 上做语义匹配——长期层没有 embedding 列。
--
-- 这个函数只用于 key 解析，不进主召回池，所以不违反「历史不进向量表」的原则：
-- 被检索的是仍然存在的当前行/失效行，不是历史表里的旧版本。
CREATE OR REPLACE FUNCTION match_memories_for_history(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 5,
  filter_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  key TEXT,
  content TEXT,
  memory_type TEXT,
  status TEXT,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.key, m.content, m.memory_type, m.status, m.valid_from, m.valid_to,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM agent_semantic_memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND filter_user_id IS NOT NULL
    AND m.user_id = filter_user_id
    -- 刻意不过滤 status
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_memories_for_history(VECTOR(1024), FLOAT, INT, UUID)
IS '历史查询专用的 key resolver：在语义层检索且不过滤 status，能解析到已失效的 key。';

NOTIFY pgrst, 'reload schema';
