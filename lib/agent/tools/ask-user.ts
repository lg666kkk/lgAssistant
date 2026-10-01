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
      : choices?.length ? "single_choice" : "free_text";
  if ((mode === "single_choice" || mode === "confirmation") && !choices?.length) {
    throw new Error(`${mode} 模式必须提供 choices`);
  }
  return { question: value.question.trim().slice(0, 500), mode, choices };
}

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  capabilities: ["user.input.request"],
  outputPolicy: { grounding: "none", citationRequired: false },
  description:
    "向用户询问完成任务所必需的信息。优先用 questions 一次提供 1–3 个问题，根据上下文生成具体候选答案，每题始终允许自定义回答。此工具用于澄清，不代替写操作授权。mode=free_text 用于开放回答；mode=single_choice 用于风险偏好、方案选择等互斥选项；mode=confirmation 用于继续/取消等明确确认。仅在缺少关键输入、且无法从已有上下文或工具获取时使用。调用后当前 Agent 会暂停，用户在问题卡片提交后，回答作为 ask_user 工具结果回填并恢复同一轮执行。",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 3,
        description: "一次询问 1–3 个相关问题，每题最多 6 个选项；界面始终提供自定义输入。优先使用此字段。",
        items: { type: "object", properties: {
          question: { type: "string", minLength: 1, maxLength: 500 },
          mode: { type: "string", enum: ["free_text", "single_choice", "confirmation"] },
          choices: { type: "array", maxItems: 6, items: { type: "string" } },
        }, required: ["question"], additionalProperties: false },
      },
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
    additionalProperties: false,
  },
  riskLevel: "safe",
  runtime: {
    ...defaultToolRuntimePolicy,
    sideEffect: "none",
    requiresConfirmation: false,
    concurrencyGroup: "user-input",
    maxConcurrency: 1,
  },
  execute: async (input: unknown): Promise<ToolResult> => {
    const raw = input as Record<string, unknown> | null;
    if (raw && "questions" in raw && (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 3)) throw new Error("questions 必须包含 1 到 3 个问题");
    const questions = Array.isArray(raw?.questions) ? raw.questions.map(parseInput) : [parseInput(input)];
    const { mode, choices } = questions[0];
    const question = questions.length === 1 ? questions[0].question : questions.map((item, index) => `${index + 1}. ${item.question}`).join("\n");
    return {
      ok: true,
      content: `等待用户回答：${question}`,
      data: { question, mode, choices, questions },
      metadata: {
        status: "awaiting_user_input",
        questions,
        question,
        mode,
        choices,
      },
    };
  },
};
