-- 记忆召回的关键词通道
--
-- 病因不是「缺索引」，是「向量对数字/型号不敏感」：
-- 「8 万」与「5 万」的余弦距离小到可忽略，纯向量通道分不开这两条记忆，
-- 于是「我预算是 8w 还是 5w」召回的可能是错的那条。
--
-- 三个刻意的取舍：
--
--   1. **不建 tsvector 生成列、不建 GIN 索引。** RAG 侧那么做是因为文档表几十万行；
--      记忆表按 user_id 过滤后单用户几百行、每行几十字，顺序扫描 + 子串匹配是微秒级。
--      建索引只是多一层要维护的复杂度，换不来可测量的延迟收益。
--
--   2. **不让数据库切词。** RAG 侧的 overlap 路径用 `regexp_split_to_table(query, '\s+')`
--      按空格切，中文无空格 → 切出来还是整句 → 退化成「原文必须一字不差出现整句」，
--      实际永不命中。这里改成由应用层把切好的词数组 p_terms 传进来
--      （见 lib/agent/memory/keyword-terms.ts：正则抽数字/Latin + Intl.Segmenter 切中文）。
--      同理不用 to_tsvector('simple')：那个配置根本不切中文。
--
--   3. **用 strpos 而不是 LIKE。** term 来自用户 query，里面可能有 % 或 _；
--      拼进 LIKE 模式就变成通配符，「50%」会匹配上任何以 50 开头的内容。
--      strpos 没有元字符概念，不需要转义，也就没有转义漏一处的可能。
--
-- 写入侧不需要任何配套改动：这里是 content 子串匹配，content 不必事先分词。
-- 这是「不建索引」额外白送的好处。

-- ============================================================
-- match_memories_keyword：关键词通道召回
-- ============================================================
-- 与 match_memories 返回同一组列（外加 keyword_rank），调用方可以用同一个
-- row → MemoryRecord 映射器，两条通道的结果才能进同一个融合器。
--
-- 打分两路取最大值：
--   key_rank     受控 key 字面量命中（query 里出现了 budget:car，或出现了它的中文
--                标签由应用层翻成 key）。这是等值匹配，最可信，直接给 1.0。
--   overlap_rank 命中的 term 数 / term 总数。0.5 表示「一半的关键词出现在这条记忆里」。
--
-- 刻意**没有** exact_rank（整句 LIKE）：应用层已经把 query 切成 term 了，
-- 整句命中必然意味着所有 term 都命中，overlap_rank 会等于 1.0，再加一路是重复计分。
DROP FUNCTION IF EXISTS match_memories_keyword(UUID, TEXT[], TEXT[], INT);

CREATE FUNCTION match_memories_keyword(
  p_user_id UUID,
  p_terms TEXT[],
  p_keys TEXT[] DEFAULT '{}',
  p_match_count INT DEFAULT 12
)
RETURNS TABLE (
  id UUID,
  key TEXT,
  layer TEXT,
  memory_type TEXT,
  source TEXT,
  confidence DOUBLE PRECISION,
  importance DOUBLE PRECISION,
  status TEXT,
  content TEXT,
  evidence JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  version INTEGER,
  keyword_rank FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  term_count INT := COALESCE(array_length(p_terms, 1), 0);
  key_count INT := COALESCE(array_length(p_keys, 1), 0);
BEGIN
  -- 与 match_memories 同一条纪律：service-role client 绕过 RLS，
  -- p_user_id 为空时**返回空集**而不是全表，用户隔离在这里是硬约束。
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  -- 两个通道输入都为空时直接返回：否则 overlap_rank 会算 0/0。
  IF term_count = 0 AND key_count = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT
      m.id, m.key, m.layer, m.memory_type, m.source, m.confidence, m.importance,
      m.status, m.content, m.evidence, m.metadata, m.created_at, m.updated_at,
      m.valid_from, m.valid_to, m.last_accessed_at, m.version,
      CASE WHEN key_count > 0 AND m.key = ANY(p_keys) THEN 1.0::FLOAT ELSE 0::FLOAT END
        AS key_rank,
      CASE
        WHEN term_count = 0 THEN 0::FLOAT
        ELSE (
          SELECT COUNT(*)::FLOAT / term_count
          FROM unnest(p_terms) AS t
          -- strpos 而不是 LIKE：term 里的 % / _ 不会变成通配符。
          WHERE t <> '' AND strpos(lower(m.content), lower(t)) > 0
        )
      END AS overlap_rank
    FROM agent_semantic_memories m
    WHERE m.user_id = p_user_id
      -- 与 match_memories 一致只看 active。历史/失效版本由
      -- match_memories_for_history 那条独立通道负责，两者的 status 语义不能混。
      AND m.status = 'active'
  )
  SELECT
    s.id, s.key, s.layer, s.memory_type, s.source, s.confidence, s.importance,
    s.status, s.content, s.evidence, s.metadata, s.created_at, s.updated_at,
    s.valid_from, s.valid_to, s.last_accessed_at, s.version,
    GREATEST(s.key_rank, s.overlap_rank) AS keyword_rank
  FROM scored s
  WHERE GREATEST(s.key_rank, s.overlap_rank) > 0
  ORDER BY GREATEST(s.key_rank, s.overlap_rank) DESC, s.updated_at DESC
  LIMIT p_match_count;
END;
$$;

COMMENT ON FUNCTION match_memories_keyword(UUID, TEXT[], TEXT[], INT)
IS '记忆关键词通道：应用层切好的 term 数组做子串匹配 + 受控 key 等值匹配，只返回指定用户的 active 记忆。';

NOTIFY pgrst, 'reload schema';
