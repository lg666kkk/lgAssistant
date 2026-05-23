-- ============================================
-- LeetCode 错题本
-- 记录做错题目、错因、复习次数和下次复习时间
-- ============================================

CREATE TABLE IF NOT EXISTS leetcode_wrong_problems (
  problem_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  wrong_reason TEXT,
  notes TEXT,
  wrong_count INTEGER NOT NULL DEFAULT 1,
  review_count INTEGER NOT NULL DEFAULT 0,
  mastery_level INTEGER NOT NULL DEFAULT 0,
  last_wrong_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reviewed_at TIMESTAMPTZ,
  next_review_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leetcode_wrong_problems_next_review_at_idx
ON leetcode_wrong_problems (next_review_at);

CREATE INDEX IF NOT EXISTS leetcode_wrong_problems_updated_at_idx
ON leetcode_wrong_problems (updated_at DESC);

COMMENT ON TABLE leetcode_wrong_problems IS 'LeetCode 错题本';
COMMENT ON COLUMN leetcode_wrong_problems.problem_id IS 'LeetCode 题号';
COMMENT ON COLUMN leetcode_wrong_problems.wrong_reason IS '做错原因';
COMMENT ON COLUMN leetcode_wrong_problems.next_review_at IS '下次建议复习时间';

