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

export type ToolGroundingMode =
  // 工具返回的是当前请求下可直接采用的确定性结果，例如时间、计算结果。
  | "authoritative_result"
  // 工具返回可引用的外部材料；最终事实陈述必须经过 EvidenceBundle 校验。
  | "cited_evidence"
  // 工具完成了写入或外部动作；结果证明动作状态，不证明任意事实 claim。
  | "action_receipt"
  // 工具只控制会话流程，不为最终答案提供事实依据，例如 ask_user。
  | "none";

/**
 * 描述工具输出进入最终回答后的验证方式。
 *
 * 该策略属于工具自身，而不是 query 关键词规则。新增工具只要声明这里，
 * Runtime 就能决定是否开启引用校验、它属于哪个检索源以及单轮调用预算，
 * 不需要再把工具名追加到中央路由器或 answer guard。
 */
export interface ToolOutputPolicy {
  grounding: ToolGroundingMode;
  citationRequired: boolean;
  retrieval?: {
    source: "knowledge" | "web";
    maxCallsPerRun: number;
  };
}

export type ToolOrchestrationCondition = "public_freshness_required";

/**
 * prerequisites 使用稳定 capability，而不是具体工具名。这样替换时间 provider
 * 或增加另一种 time.current 工具时，依赖方无需修改。
 * invokeWhen 表示“前置依赖何时生效”，不是限制工具只能在该条件下调用。
 */
export interface ToolOrchestrationPolicy {
  prerequisites: string[];
  invokeWhen: ToolOrchestrationCondition;
}

export interface ToolDefinition {
  name: string; // 工具名称
  description: string; // 工具说明
  capabilities: string[]; // 工具能完成的稳定能力，不与具体工具名绑定
  outputPolicy: ToolOutputPolicy; // 运行时如何验证该工具的输出
  orchestration?: ToolOrchestrationPolicy; // 条件生效时必须先满足的能力依赖
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
