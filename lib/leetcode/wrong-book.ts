import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import {
  LEETCODE_HOT_100_PROBLEMS,
  type LeetCodeDifficulty,
  type LeetCodeProblem,
} from "./hot-100";

type WrongBookRow = {
  problem_id: number;
  title: string;
  slug: string;
  difficulty: LeetCodeDifficulty;
  tags: string[];
  wrong_reason?: string;
  notes?: string;
  wrong_count: number;
  review_count: number;
  mastery_level: number;
  last_wrong_at: string;
  last_reviewed_at?: string;
  next_review_at: string;
  created_at?: string;
  updated_at?: string;
};

export type LeetCodeWrongProblem = LeetCodeProblem & {
  wrongCount: number;
  reviewCount: number;
  masteryLevel: number;
  wrongReason?: string;
  notes?: string;
  lastWrongAt: string;
  lastReviewedAt?: string;
  nextReviewAt: string;
};

type RecordWrongProblemInput = {
  problemId?: number;
  title?: string;
  wrongReason?: string;
  notes?: string;
  solvedAt?: string;
};

type UpdateReviewInput = {
  problemId?: number;
  title?: string;
  isCorrect: boolean;
  notes?: string;
};

type QueryWrongProblemsInput = {
  dueOnly?: boolean;
  limit?: number;
};

const LOCAL_STORAGE_FILE = path.join(process.cwd(), "data", "leetcode-wrong-book.json");
const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30];

function getProblemById(problemId: number): LeetCodeProblem | null {
  return LEETCODE_HOT_100_PROBLEMS.find((problem) => problem.id === problemId) ?? null;
}

function getProblemByTitle(title: string): LeetCodeProblem | null {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return null;
  }

  return (
    LEETCODE_HOT_100_PROBLEMS.find((problem) => problem.title === normalizedTitle) ??
    LEETCODE_HOT_100_PROBLEMS.find((problem) => problem.title.includes(normalizedTitle)) ??
    null
  );
}

function getProblemFromInput(input: RecordWrongProblemInput): LeetCodeProblem {
  if (typeof input.problemId === "number" && Number.isFinite(input.problemId)) {
    const problem = getProblemById(input.problemId);
    if (problem) {
      return problem;
    }
  }

  if (typeof input.title === "string" && input.title.trim()) {
    const problem = getProblemByTitle(input.title);
    if (problem) {
      return problem;
    }
  }

  throw new Error("未找到对应的 LeetCode 题目，请提供正确的题号或标题");
}

function toDateWithOffset(date: Date, offsetDays: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + offsetDays);
  return next.toISOString();
}

function getNextReviewOffsetDays(reviewCount: number): number {
  return REVIEW_INTERVAL_DAYS[Math.min(reviewCount, REVIEW_INTERVAL_DAYS.length - 1)];
}

function toRow(problem: LeetCodeProblem, input: RecordWrongProblemInput, existing?: WrongBookRow): WrongBookRow {
  const now = new Date().toISOString();
  const reviewCount = existing?.review_count ?? 0;
  const wrongCount = (existing?.wrong_count ?? 0) + 1;
  const nextReviewAt = toDateWithOffset(new Date(), getNextReviewOffsetDays(reviewCount));

  return {
    problem_id: problem.id,
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty,
    tags: problem.tags,
    wrong_reason: input.wrongReason?.trim() || existing?.wrong_reason,
    notes: input.notes?.trim() || existing?.notes,
    wrong_count: wrongCount,
    review_count: reviewCount,
    mastery_level: 0,
    last_wrong_at: input.solvedAt?.trim() || now,
    last_reviewed_at: existing?.last_reviewed_at,
    next_review_at: nextReviewAt,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function toWrongProblem(row: WrongBookRow): LeetCodeWrongProblem {
  const problem = getProblemById(row.problem_id);
  return {
    id: row.problem_id,
    title: row.title,
    slug: row.slug,
    difficulty: row.difficulty,
    tags: row.tags,
    url: problem?.url ?? `https://leetcode.cn/problems/${row.slug}/`,
    wrongCount: row.wrong_count,
    reviewCount: row.review_count,
    masteryLevel: row.mastery_level,
    wrongReason: row.wrong_reason,
    notes: row.notes,
    lastWrongAt: row.last_wrong_at,
    lastReviewedAt: row.last_reviewed_at,
    nextReviewAt: row.next_review_at,
  };
}

function normalizeRows(rows: unknown): WrongBookRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter((row): row is WrongBookRow => {
    if (!row || typeof row !== "object") {
      return false;
    }
    const value = row as Record<string, unknown>;
    return (
      typeof value.problem_id === "number" &&
      typeof value.title === "string" &&
      typeof value.slug === "string" &&
      typeof value.difficulty === "string" &&
      Array.isArray(value.tags) &&
      typeof value.wrong_count === "number" &&
      typeof value.review_count === "number" &&
      typeof value.mastery_level === "number" &&
      typeof value.last_wrong_at === "string" &&
      typeof value.next_review_at === "string"
    );
  });
}

async function readLocalRows(): Promise<WrongBookRow[]> {
  try {
    const content = await readFile(LOCAL_STORAGE_FILE, "utf8");
    return normalizeRows(JSON.parse(content));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeLocalRows(rows: WrongBookRow[]): Promise<void> {
  await mkdir(path.dirname(LOCAL_STORAGE_FILE), { recursive: true });
  await writeFile(LOCAL_STORAGE_FILE, JSON.stringify(rows, null, 2), "utf8");
}

async function getAllRows(): Promise<WrongBookRow[]> {
  if (!hasSupabaseConfig()) {
    return readLocalRows();
  }

  const { data, error } = await getSupabase()
    .from("leetcode_wrong_problems")
    .select("*")
    .order("next_review_at", { ascending: true })
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`读取 LeetCode 错题本失败: ${error.message}`);
  }

  return normalizeRows(data ?? []);
}

async function getExistingRow(problemId: number): Promise<WrongBookRow | null> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalRows();
    return rows.find((row) => row.problem_id === problemId) ?? null;
  }

  const { data, error } = await getSupabase()
    .from("leetcode_wrong_problems")
    .select("*")
    .eq("problem_id", problemId)
    .maybeSingle();

  if (error) {
    throw new Error(`读取 LeetCode 错题失败: ${error.message}`);
  }

  return data as WrongBookRow | null;
}

async function saveRow(row: WrongBookRow): Promise<WrongBookRow> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalRows();
    const index = rows.findIndex((item) => item.problem_id === row.problem_id);

    if (index >= 0) {
      rows[index] = row;
    } else {
      rows.push(row);
    }

    await writeLocalRows(rows);
    return row;
  }

  const { data, error } = await getSupabase()
    .from("leetcode_wrong_problems")
    .upsert(row, { onConflict: "problem_id" })
    .select("*")
    .single();

  if (error) {
    throw new Error(`保存 LeetCode 错题失败: ${error.message}`);
  }

  return data as WrongBookRow;
}

function sortProblems(rows: WrongBookRow[]): WrongBookRow[] {
  return [...rows].sort((a, b) => {
    const nextReviewDiff = a.next_review_at.localeCompare(b.next_review_at);
    if (nextReviewDiff !== 0) {
      return nextReviewDiff;
    }
    return b.wrong_count - a.wrong_count;
  });
}

function isDue(row: WrongBookRow, now = new Date()): boolean {
  return new Date(row.next_review_at).getTime() <= now.getTime();
}

export async function recordLeetCodeWrongProblem(input: RecordWrongProblemInput): Promise<LeetCodeWrongProblem> {
  const problem = getProblemFromInput(input);
  const existing = await getExistingRow(problem.id);
  const row = toRow(problem, input, existing ?? undefined);
  const saved = await saveRow(row);
  return toWrongProblem(saved);
}

export async function markLeetCodeProblemReviewed(input: UpdateReviewInput): Promise<LeetCodeWrongProblem> {
  const problem = getProblemFromInput(input);
  const existing = await getExistingRow(problem.id);

  if (!existing) {
    throw new Error("错题本里没有这道题，先记录为错题再复习");
  }

  const now = new Date().toISOString();
  const reviewCount = existing.review_count + 1;
  const masteryLevel = Math.min(existing.mastery_level + 1, 5);
  const nextReviewAt = toDateWithOffset(new Date(), getNextReviewOffsetDays(reviewCount));
  const row: WrongBookRow = {
    ...existing,
    review_count: reviewCount,
    mastery_level: masteryLevel,
    last_reviewed_at: now,
    next_review_at: nextReviewAt,
    notes: input.notes?.trim() || existing.notes,
    updated_at: now,
  };

  const saved = await saveRow(row);
  return toWrongProblem(saved);
}

export async function listLeetCodeWrongProblems(input: QueryWrongProblemsInput = {}): Promise<LeetCodeWrongProblem[]> {
  const rows = await getAllRows();
  const filtered = input.dueOnly ? rows.filter((row) => isDue(row)) : rows;
  const sorted = sortProblems(filtered);
  const limited = typeof input.limit === "number" && input.limit > 0 ? sorted.slice(0, input.limit) : sorted;
  return limited.map(toWrongProblem);
}

export async function getDueLeetCodeReviews(input: { limit?: number } = {}): Promise<LeetCodeWrongProblem[]> {
  return listLeetCodeWrongProblems({
    dueOnly: true,
    limit: input.limit ?? 10,
  });
}

export function formatLeetCodeWrongProblems(problems: LeetCodeWrongProblem[]): string {
  if (problems.length === 0) {
    return "错题本里还没有记录，或者今天没有到期的复习题。";
  }

  const lines = problems
    .map(
      (problem, index) =>
        `${index + 1}. ${problem.id} - ${problem.title}（${problem.difficulty}）\n` +
        `   - 链接：${problem.url}\n` +
        `   - 错因：${problem.wrongReason ?? "未填写"}\n` +
        `   - 备注：${problem.notes ?? "无"}\n` +
        `   - 错题次数：${problem.wrongCount}，复习次数：${problem.reviewCount}，掌握度：${problem.masteryLevel}/5\n` +
        `   - 下次复习：${problem.nextReviewAt}`,
    )
    .join("\n\n");

  return lines;
}

