-- ============================================
-- LeetCode 热题 100 每日练习计划
-- 每天随机 5 道；同一轮 100 道内不重复；完成 100 道后自动开启下一轮
-- ============================================

CREATE TABLE IF NOT EXISTS leetcode_daily_practices (
  practice_date DATE PRIMARY KEY,
  round_no INTEGER NOT NULL DEFAULT 1,
  problem_ids INTEGER[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leetcode_daily_practices_round_no_idx
ON leetcode_daily_practices (round_no);

COMMENT ON TABLE leetcode_daily_practices IS 'LeetCode 热题 100 每日练习记录';
COMMENT ON COLUMN leetcode_daily_practices.practice_date IS '练习日期，同一天重复请求返回同一批题';
COMMENT ON COLUMN leetcode_daily_practices.round_no IS '练习轮次，100 道全部安排完后进入下一轮';
COMMENT ON COLUMN leetcode_daily_practices.problem_ids IS '当天安排的 LeetCode 题号列表';
