import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";

type CreateTodoInput = {
  title: string;
  dueAt?: string;
  notes?: string;
  priority?: "low" | "medium" | "high";
};

function parseInput(input: unknown): CreateTodoInput {
  if (!input || typeof input !== "object") {
    throw new Error("参数必须是对象");
  }
  const data = input as Record<string, unknown>;
  if (typeof data.title !== "string" || !data.title.trim()) {
    throw new Error("title 必须是非空字符串");
  }

  if (data.dueAt !== undefined && typeof data.dueAt !== "string") {
    throw new Error("dueAt 必须是字符串");
  }

  if (data.notes !== undefined && typeof data.notes !== "string") {
    throw new Error("notes 必须是字符串");
  }
  if (
    data.priority !== undefined &&
    data.priority !== "low" &&
    data.priority !== "medium" &&
    data.priority !== "high"
  ) {
    throw new Error("priority 必须是 low、medium 或 high");
  }

  return {
    title: data.title.trim(),
    dueAt: data.dueAt,
    notes: data.notes,
    priority: data.priority,
  };
}

export const createTodoTool: ToolDefinition = {
  runtime: {
    ...defaultToolRuntimePolicy,
    sideEffect: "write",
    requiresConfirmation: true,
    concurrencyGroup: "writes",
    maxConcurrency: 1,
  },
  name: "create_todo",
  description:
    "创建一个待办事项。仅当用户明确要求创建、新增、记录或加入待办/TODO 时使用；‘提醒一下，我喜欢/习惯/过敏……’是在陈述长期偏好，不是创建待办，禁止调用本工具。这个工具会写入数据，必须先经过用户确认。",
  riskLevel: "confirm",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "待办事项标题",
      },
      dueAt: {
        type: "string",
        description: "截止或提醒时间，尽量使用 ISO 时间或清晰的自然语言时间",
      },
      notes: {
        type: "string",
        description: "补充说明",
      },
      priority: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "优先级，可选值为 low、medium、high",
      },
    },
    additionalProperties: false,
    required: ["title"],
  },
  execute: async (input: unknown): Promise<ToolResult> => {
    const todo = parseInput(input);

    return {
      ok: true,
      content: `已准备创建待办：${todo.title}`,
      data: todo,
    };
  },
};
