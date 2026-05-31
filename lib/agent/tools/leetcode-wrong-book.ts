import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";
import {
  formatLeetCodeWrongProblems,
  getDueLeetCodeReviews,
  listLeetCodeWrongProblems,
  markLeetCodeProblemReviewed,
  recordLeetCodeWrongProblem,
} from "@/lib/leetcode/wrong-book";

type LeetCodeWrongBookInput =
  | {
      action?: "record" | "list" | "due" | "review";
      problemId?: number;
      title?: string;
      wrongReason?: string;
      notes?: string;
      solvedAt?: string;
      isCorrect?: boolean;
      dueOnly?: boolean;
      limit?: number;
    }
  | undefined;

type ParsedLeetCodeWrongBookInput = {
  action: "record" | "list" | "due" | "review";
  problemId?: number;
  title?: string;
  wrongReason?: string;
  notes?: string;
  solvedAt?: string;
  isCorrect?: boolean;
  dueOnly?: boolean;
  limit?: number;
};

function parseInput(input: unknown): ParsedLeetCodeWrongBookInput {
  if (!input || typeof input !== "object") {
    return { action: "record" };
  }

  const value = input as Record<string, unknown>;
  const action =
    value.action === "list" || value.action === "due" || value.action === "review" ? value.action : "record";

  return {
    action,
    problemId: typeof value.problemId === "number" ? value.problemId : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    wrongReason: typeof value.wrongReason === "string" ? value.wrongReason : undefined,
    notes: typeof value.notes === "string" ? value.notes : undefined,
    solvedAt: typeof value.solvedAt === "string" ? value.solvedAt : undefined,
    isCorrect: typeof value.isCorrect === "boolean" ? value.isCorrect : undefined,
    dueOnly: typeof value.dueOnly === "boolean" ? value.dueOnly : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
  };
}

export const leetCodeWrongBookTool: ToolDefinition = {
  name: "leetcode_wrong_book",
  description:
    "管理 LeetCode 错题本。支持记录做错的题、查看全部错题、查看今日到期复习题、标记复习结果。适合用户说“这题我做错了”“帮我看看该复习哪些题”“我复习完了”时使用。",
  runtime: {
    ...defaultToolRuntimePolicy
  },
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["record", "list", "due", "review"],
        description: "操作类型：record 记录错题，list 查看全部，due 查看到期复习，review 标记复习结果",
      },
      problemId: {
        type: "number",
        description: "LeetCode 题号，优先使用",
      },
      title: {
        type: "string",
        description: "LeetCode 题目标题，当没有题号时使用",
      },
      wrongReason: {
        type: "string",
        description: "做错原因",
      },
      notes: {
        type: "string",
        description: "补充备注",
      },
      solvedAt: {
        type: "string",
        description: "做题或记录时间，默认当前时间",
      },
      isCorrect: {
        type: "boolean",
        description: "复习是否做对，仅在 review 时使用",
      },
      dueOnly: {
        type: "boolean",
        description: "是否只查看今天到期的复习题",
      },
      limit: {
        type: "number",
        description: "最多返回多少题",
      },
    },
    additionalProperties: false,
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const parsed = parseInput(input);

    try {
      if (parsed.action === "list") {
        const problems = await listLeetCodeWrongProblems({
          dueOnly: parsed.dueOnly ?? false,
          limit: parsed.limit ?? 20,
        });
        return {
          ok: true,
          content: formatLeetCodeWrongProblems(problems),
          data: {
            problems,
          },
        };
      }

      if (parsed.action === "due") {
        const problems = await getDueLeetCodeReviews({
          limit: parsed.limit ?? 10,
        });
        return {
          ok: true,
          content: formatLeetCodeWrongProblems(problems),
          data: {
            problems,
          },
        };
      }

      if (parsed.action === "review") {
        if (typeof parsed.isCorrect !== "boolean") {
          return {
            ok: false,
            content: "标记复习结果时需要提供 isCorrect",
            error: "Missing isCorrect",
          };
        }

        const result = await markLeetCodeProblemReviewed({
          problemId: parsed.problemId,
          title: parsed.title,
          isCorrect: parsed.isCorrect,
          notes: parsed.notes,
        });

        return {
          ok: true,
          content: `已更新复习记录：${result.id} - ${result.title}`,
          data: result,
        };
      }

      const result = await recordLeetCodeWrongProblem({
        problemId: parsed.problemId,
        title: parsed.title,
        wrongReason: parsed.wrongReason,
        notes: parsed.notes,
        solvedAt: parsed.solvedAt,
      });

      return {
        ok: true,
        content: `已记录错题：${result.id} - ${result.title}，下次复习时间 ${result.nextReviewAt}`,
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        content: "操作错题本失败",
        error: error instanceof Error ? error.message : "LeetCode wrong book failed",
      };
    }
  },
};
