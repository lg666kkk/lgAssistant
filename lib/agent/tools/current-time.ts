import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";

type CurrentTimeInput = {
  timezone?: string;
  locale?: string;
};

function parseInput(input: unknown): CurrentTimeInput {
  if (!input || typeof input !== "object") {
    return {};
  }
  const value = input as Record<string, unknown>;

  return {
    timezone: typeof value.timezone === "string" ? value.timezone : undefined,
    locale: typeof value.locale === "string" ? value.locale : undefined,
  };
}

export const getCurrentTimeTool: ToolDefinition = {
  name: "get_current_time",
  description:
    "获取服务器当前时间，可按指定 timezone 和 locale 格式化。适合回答当前日期、当前时间、今天是星期几等问题。",
  runtime: {
    ...defaultToolRuntimePolicy
  },
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: '时区，如 "Asia/Shanghai"、"UTC" 等',
      },
      locale: {
        type: "string",
        description: '本地化格式，如 "zh-CN"、"en-US" 等',
      },
    },
    required: [],
    additionalProperties: false, // 是否允许出现 schema 里没声明的额外参数
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const { timezone = "Asia/Shanghai", locale = "zh-CN" } = parseInput(input);
    const now = new Date();
    try {
      const formatted = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "medium",
      }).format(now);
      return {
        content: `当前时间：${formatted}`,
        ok: true,
        data: {
          iso: now.toISOString(),
          timezone,
          locale,
          formatted,
          timestamp: now.getTime(),
        },
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "时间格式化失败";

      return {
        ok: false,
        content: `获取当前时间失败：${message}`,
        error: message,
      };
    }
  },
};
