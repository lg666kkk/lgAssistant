import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolResult,
} from "./types";

type AskUserInput = {
  question: string;
  mode?: "free_text" | "single_choice" | "confirmation";
  choices?: string[];
};

function parseInput(input: unknown): AskUserInput {
  if (!input || typeof input !== "object") {
    throw new Error("参数必须是对象");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.question !== "string" || !value.question.trim()) {
    throw new Error("question 必须是非空字符串");
  }
  const choices = Array.isArray(value.choices)
    ? value.choices
        .filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
        .slice(0, 6)
    : undefined;
  const mode =
    value.mode === "single_choice" || value.mode === "confirmation"
      ? value.mode
      : "free_text";
  if ((mode === "single_choice" || mode === "confirmation") && !choices?.length) {
    throw new Error(`${mode} 模式必须提供 choices`);
  }
  return { question: value.question.trim().slice(0, 500), mode, choices };
}

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "向用户询问完成任务所必需的信息或确认。mode=free_text 用于开放回答；mode=single_choice 用于风险偏好、方案选择等互斥选项；mode=confirmation 用于继续/取消等明确确认。仅在缺少关键输入、且无法从已有上下文或工具获取时使用。调用后当前 Agent 会暂停，等待用户下一条消息回答。",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "需要用户回答的清晰、具体问题",
      },
      mode: {
        type: "string",
        enum: ["free_text", "single_choice", "confirmation"],
        description: "交互类型；有明确候选项时使用 single_choice，需要继续/取消时使用 confirmation",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "可选答案，最多 6 项；用户仍可自由输入其他答案",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  riskLevel: "safe",
  runtime: {
    ...defaultToolRuntimePolicy,
    sideEffect: "none",
    requiresConfirmation: true,
    concurrencyGroup: "user-input",
    maxConcurrency: 1,
  },
  execute: async (input: unknown): Promise<ToolResult> => {
    const { question, mode, choices } = parseInput(input);
    return {
      ok: true,
      content: `等待用户回答：${question}`,
      data: { question, mode, choices },
      metadata: {
        status: "awaiting_user_input",
        question,
        mode,
        choices,
      },
    };
  },
};
