/***
 * safe 可以自动执行的工具
 * confirm 需要用户确认的工具
 * dangerous 默认拒绝
 */
export type ToolRiskLevel = "safe" | "confirm" | "dangerous";

/**
 * 工具返回结果
 */
export interface ToolResult {
  ok: boolean; // 工具是否执行成功
  content: string; // 给模型看的主要文本结果
  data?: unknown; // 给程序用的结构化数据
  error?: string; // 失败时的错误信息
  metadata?: Record<string, unknown>; // 额外信息, 比如耗时、来源
}

export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolRuntimePolicy {
  requiresAuth: boolean;
  rateLimit?: number;
  timeoutSeconds: number;
  memoryLimitMb: number;
  sandboxed: boolean;
  dangerous: boolean;
  costPerUse: number;
  sideEffect: "none" | "read" | "write" | "external";
  concurrencyGroup?: string;
  maxConcurrency?: number;
  requiresConfirmation: boolean;
}

export interface ToolDefinition {
  name: string; // 工具名称
  description: string; // 工具说明
  input_schema: ToolInputSchema; // 工具参数
  riskLevel: ToolRiskLevel; // 工具风险等级
  execute(params: unknown, context?: ToolExecutionContext): Promise<ToolResult>; // 执行工具的函数
  runtime: ToolRuntimePolicy;
}
// 它表示 一次工具调用请求。
export interface ToolCall {
  id?: string; // 工具调用ID
  name: string; // 工具名称
  input: unknown; // 工具参数
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionResult extends ToolResult {
  toolName: string; // 工具名称
  toolCallId?: string; // 工具调用ID
}

export type ExecuteToolCallOptions = {
  approved?: boolean;
  scopeId?: string;
  userId?: string;
  requestId?: string;
  conversationContext?: string[];
};

export type ToolExecutionContext = {
  userId?: string;
  scopeId?: string;
  requestId?: string;
  conversationContext?: string[];
};

export const defaultToolRuntimePolicy: ToolRuntimePolicy = {
  requiresAuth: false,
  rateLimit: undefined,
  timeoutSeconds: 30,
  memoryLimitMb: 512,
  sandboxed: true,
  dangerous: false,
  costPerUse: 0,
  sideEffect: "read",
  concurrencyGroup: "default",
  maxConcurrency: 4,
  requiresConfirmation: false,
};
