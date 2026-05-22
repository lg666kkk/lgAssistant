import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import {
  LEETCODE_HOT_100_PROBLEMS,
  LEETCODE_HOT_100_TOTAL,
  type LeetCodeProblem,
} from "./hot-100";

type PracticeRow = {
  practice_date: string;
  round_no: number;
  problem_ids: number[];
  created_at?: string;
};

export type DailyLeetCodePractice = {
  date: string;
  roundNo: number;
  problems: LeetCodeProblem[];
  completedInRound: number;
  remainingInRound: number;
  total: number;
};

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_DAILY_COUNT = 5;
const LOCAL_STORAGE_FILE = path.join(process.cwd(), "data", "leetcode-daily-practices.json");

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("无法生成练习日期");
  }

  return `${year}-${month}-${day}`;
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function idsToProblems(ids: number[]): LeetCodeProblem[] {
  const problemById = new Map(
    LEETCODE_HOT_100_PROBLEMS.map((problem) => [problem.id, problem]),
  );

  return ids
    .map((id) => problemById.get(id))
    .filter((problem): problem is LeetCodeProblem => Boolean(problem));
}

async function readLocalPracticeRows(): Promise<PracticeRow[]> {
  try {
    const content = await readFile(LOCAL_STORAGE_FILE, "utf8");
    const rows = JSON.parse(content);
    return Array.isArray(rows) ? rows as PracticeRow[] : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeLocalPracticeRows(rows: PracticeRow[]): Promise<void> {
  await mkdir(path.dirname(LOCAL_STORAGE_FILE), { recursive: true });
  await writeFile(LOCAL_STORAGE_FILE, JSON.stringify(rows, null, 2), "utf8");
}

async function getExistingPractice(date: string): Promise<PracticeRow | null> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalPracticeRows();
    return rows.find((row) => row.practice_date === date) ?? null;
  }

  const { data, error } = await getSupabase()
    .from("leetcode_daily_practices")
    .select("practice_date, round_no, problem_ids, created_at")
    .eq("practice_date", date)
    .maybeSingle();

  if (error) {
    throw new Error(`读取 LeetCode 每日练习失败: ${error.message}`);
  }

  return data as PracticeRow | null;
}

async function getLatestPractice(): Promise<PracticeRow | null> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalPracticeRows();
    return rows.sort((a, b) => b.practice_date.localeCompare(a.practice_date))[0] ?? null;
  }

  const { data, error } = await getSupabase()
    .from("leetcode_daily_practices")
    .select("practice_date, round_no, problem_ids, created_at")
    .order("practice_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`读取 LeetCode 最新练习失败: ${error.message}`);
  }

  return data as PracticeRow | null;
}

async function getRowsInRound(roundNo: number): Promise<PracticeRow[]> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalPracticeRows();
    return rows
      .filter((row) => row.round_no === roundNo)
      .sort((a, b) => a.practice_date.localeCompare(b.practice_date));
  }

  const { data, error } = await getSupabase()
    .from("leetcode_daily_practices")
    .select("practice_date, round_no, problem_ids, created_at")
    .eq("round_no", roundNo)
    .order("practice_date", { ascending: true });

  if (error) {
    throw new Error(`读取 LeetCode 练习轮次失败: ${error.message}`);
  }

  return (data ?? []) as PracticeRow[];
}

async function createPractice(row: PracticeRow): Promise<PracticeRow> {
  if (!hasSupabaseConfig()) {
    const rows = await readLocalPracticeRows();
    if (rows.some((item) => item.practice_date === row.practice_date)) {
      throw new Error("Duplicate local practice date");
    }

    const createdRow = {
      ...row,
      created_at: new Date().toISOString(),
    };
    await writeLocalPracticeRows([...rows, createdRow]);
    return createdRow;
  }

  const { data, error } = await getSupabase()
    .from("leetcode_daily_practices")
    .insert(row)
    .select("practice_date, round_no, problem_ids, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      const createdByConcurrentRequest = await getExistingPractice(row.practice_date);
      if (createdByConcurrentRequest) {
        return createdByConcurrentRequest;
      }
    }

    throw new Error(`创建 LeetCode 每日练习失败: ${error.message}`);
  }

  return data as PracticeRow;
}

function toPracticeResult(row: PracticeRow, usedIdsInRound: number[]): DailyLeetCodePractice {
  const completedInRound = new Set(usedIdsInRound).size;

  return {
    date: row.practice_date,
    roundNo: row.round_no,
    problems: idsToProblems(row.problem_ids),
    completedInRound,
    remainingInRound: Math.max(LEETCODE_HOT_100_TOTAL - completedInRound, 0),
    total: LEETCODE_HOT_100_TOTAL,
  };
}

export async function getDailyLeetCodePractice(options: {
  date?: Date;
  timeZone?: string;
  count?: number;
} = {}): Promise<DailyLeetCodePractice> {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const count = options.count ?? DEFAULT_DAILY_COUNT;
  const practiceDate = getDateInTimeZone(options.date ?? new Date(), timeZone);
  const existingPractice = await getExistingPractice(practiceDate);

  if (existingPractice) {
    const roundRows = await getRowsInRound(existingPractice.round_no);
    const usedIds = roundRows.flatMap((row) => row.problem_ids);
    return toPracticeResult(existingPractice, usedIds);
  }

  const latestPractice = await getLatestPractice();
  let roundNo = latestPractice?.round_no ?? 1;
  let roundRows = await getRowsInRound(roundNo);
  let usedIds = new Set(roundRows.flatMap((row) => row.problem_ids));

  if (usedIds.size >= LEETCODE_HOT_100_TOTAL) {
    roundNo += 1;
    roundRows = [];
    usedIds = new Set<number>();
  }

  const availableIds = LEETCODE_HOT_100_PROBLEMS
    .map((problem) => problem.id)
    .filter((id) => !usedIds.has(id));
  const selectedIds = shuffle(availableIds).slice(0, count);
  const createdPractice = await createPractice({
    practice_date: practiceDate,
    round_no: roundNo,
    problem_ids: selectedIds,
  });
  const currentUsedIds = Array.from(usedIds).concat(selectedIds);
  return toPracticeResult(createdPractice, currentUsedIds);
}

export function formatDailyLeetCodePractice(practice: DailyLeetCodePractice): string {
  const problemLines = practice.problems
    .map(
      (problem, index) =>
        `${index + 1}. ${problem.id}. ${problem.title}（${problem.difficulty}）\n   ${problem.url}\n   标签：${problem.tags.join("、")}`,
    )
    .join("\n");

  return [
    `今天的 LeetCode 热题 100 练习（${practice.date}）：`,
    problemLines,
    `当前第 ${practice.roundNo} 轮：已安排 ${practice.completedInRound}/${practice.total} 道，剩余 ${practice.remainingInRound} 道。`,
  ].join("\n\n");
}
