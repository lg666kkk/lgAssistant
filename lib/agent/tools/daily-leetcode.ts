import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";
import {
  formatDailyLeetCodePractice,
  getDailyLeetCodePractice,
} from "@/lib/leetcode/daily-practice";

type DailyLeetCodeInput = {
  timeZone?: string;
};

function parseInput(input: unknown): DailyLeetCodeInput {
  if (!input || typeof input !== "object") {
    return {};
  }

  const data = input as Record<string, unknown>;
  return {
    timeZone: typeof data.timeZone === "string" ? data.timeZone : undefined,
  };
}

export const dailyLeetCodeTool: ToolDefinition = {
  name: "get_daily_leetcode_practice",
  description:
    "获取今天的 LeetCode 热题 100 随机练习清单。每天固定返回 5 道题；同一轮 100 道内不会重复，全部练完后自动开启新一轮。适合用户询问今天刷什么题、每日算法练习、LeetCode 训练计划时使用。",
  input_schema: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description: "日期所使用的时区，默认 Asia/Shanghai",
      },
    },
    additionalProperties: false,
  },
  runtime: {
    ...defaultToolRuntimePolicy
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const { timeZone } = parseInput(input);

    try {
      const practice = await getDailyLeetCodePractice({ timeZone });
      return {
        ok: true,
        content: formatDailyLeetCodePractice(practice),
        data: practice,
      };
    } catch (error) {
      return {
        ok: false,
        content: "获取 LeetCode 每日练习失败，请确认数据库表 leetcode_daily_practices 已创建。",
        error: error instanceof Error ? error.message : "Get daily LeetCode practice failed",
      };
    }
  },
};
