import { truncateToolContent } from "./budget";
import type { AgentLoopMetrics, AgentLoopStopReason } from "./index";
import type { ChatModelId, ModelUsageBreakdown } from "@/lib/agent/models";
import type {
  EvidenceGrade,
  GroundednessReport,
  RetrievalAttempt,
  RetrievalFilters,
  RetrievalRoute,
  RetrievalSource,
} from "@/lib/agent/rag/types";
import type { ContextPlan } from "@/lib/agent/context/types";
import type { MemoryConsolidationOutcome } from "@/lib/agent/memory/memory-flow";

export type TraceStepBase = {
  index: number; // model/tool 共享的递增序号，用来还原真实时间线
  startedAt: number; // Date.now() 时间戳
  durationMs?: number;
};

export type ModelTraceStep = TraceStepBase & {
  type: "model";
  model?: ChatModelId;
  textSummary: string; // 模型这轮吐的文本（截断后的摘要）
  textTruncated: boolean;
  textOriginalChars: number;
  requestedToolCalls: Array<{ name: string; id: string; input: unknown }>; // 这轮想调哪些工具
  estimatedContextTokens: number; // 复用 loop 本轮已算的值
  tokenBudget?: {
    max: number;
    spentBefore: number;
    spentAfter: number;
    remainingBefore: number;
    remainingAfter: number;
    requested: number;
    reservedOutputTokens?: number;
  };
  usage?: ModelUsageBreakdown; // 模型返回的真实 token 和费用估算，有就填
  // 上下文工程可观测性核心：这轮注入给模型的 system prompt（截断后）。
  // 让 trace 详情页能回答「这次到底喂了什么上下文」。整个 loop 的 system 不变，
  // 但仍逐 step 记录，方便单看任意一步就知道当时的上下文。
  systemPrompt?: string;
  systemPromptTruncated?: boolean;
  systemPromptOriginalChars?: number;
  // 段化后的注入结构（身份/记忆/策略…）。详情页优先按段分块展示，
  // 没有时回退到 systemPrompt 整段。旧 trace 没有此字段，前端兼容处理。
  systemSegments?: Array<{
    kind: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  contextPlanId?: string;
};

export type ToolTraceStep = TraceStepBase & {
  type: "tool";
  name: string;
  toolCallId?: string;
  input: unknown;
  ok: boolean;
  contentSummary: string; // 压缩后给模型看的工具结果
  contentTruncated: boolean;
  contentOriginalChars: number;
  rawContentSummary?: string; // 压缩前原始工具结果的截断预览，仅用于 trace 展示
  rawContentTruncated?: boolean;
  rawContentOriginalChars?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  costPerUse: number;
};

export type ContextCompactionTraceStep = TraceStepBase & {
  type: "context_compaction";
  beforeTokens: number;
  afterTokens: number;
  modelWindowTokens: number;
  triggerTokens: number;
  targetTokens: number;
  primerMessages: number;
  recentMessages: number;
  middleMessageCount: number;
  reason: string;
  summary: string;
  summaryChars: number;
  method?: "deterministic" | "semantic";
  compressionModel?: string;
  fallbackReason?: string;
};

export type PlanTraceStep = TraceStepBase & {
  type: "plan";
  planId: string;
  stepId?: string;
  phase: "created" | "executed" | "verified";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  goal: string;
  successCriteria: string[];
  allowedTools: string[];
  resultSummary?: string;
  failureReason?: string;
};

export type RetrievalTraceStep = TraceStepBase & {
  type: "retrieval";
  phase: "routed" | "graded";
  /** 实际产生 EvidenceBundle 的工具，用于区分 web_search、web_fetch 等检索操作。 */
  toolName?: string;
  planId: string;
  route: RetrievalRoute;
  reason: string;
  confidence?: number;
  freshnessRequired?: boolean;
  evidenceRequired?: boolean;
  maxAttempts: number;
  indexVersion: string;
  source?: RetrievalSource;
  query?: string;
  filters?: RetrievalFilters;
  evidenceCount?: number;
  grade?: EvidenceGrade;
  cacheHits?: number;
  queryAttempts?: number;
  thresholdFallback?: boolean;
  scoreGap?: number | null;
  degradationReason?: string;
  attempts?: RetrievalAttempt[];
  timings?: Record<string, number>;
};

export type AnswerValidationTraceStep = TraceStepBase & {
  type: "answer_validation";
  report: GroundednessReport;
  guarded: boolean;
};

export type MemoryConsolidationTraceStep = TraceStepBase & {
  type: "memory_consolidation";
  outcome: MemoryConsolidationOutcome;
};

export type TraceStep =
  | ModelTraceStep
  | ToolTraceStep
  | ContextCompactionTraceStep
  | PlanTraceStep
  | RetrievalTraceStep
  | MemoryConsolidationTraceStep
  | AnswerValidationTraceStep; // 判别联合

export type AgentTrace = {
  requestId: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  totalDurationMs?: number;
  stopReason: AgentLoopStopReason;
  completed: boolean;
  steps: TraceStep[];
  metrics: AgentLoopMetrics; // 直接复用现有聚合 metrics，trace 是明细，metrics 是汇总，并存
  contextPlan?: ContextPlan;
};

export function createTrace(requestId: string, sessionId?: string): AgentTrace {
  return {
    requestId,
    sessionId,
    startedAt: Date.now(),
    stopReason: "completed", // 占位，loop 结束时回填真实值
    completed: false,
    steps: [],
    metrics: {
      estimatedTokensSpent: 0,
      modelCallCount: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualTotalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      estimatedModelCostCny: 0,
      toolCallCount: 0,
      totalToolCost: 0,
      toolDurations: [],
    },
  };
}
// 文本摘要
export function summarizeText(text: string) {
  return truncateToolContent(text, 500);   // 返回 { content, truncated, originalChars }
}

// 把 trace 渲染成缩进调用树，方便在终端一眼看清一次请求做了什么
export function formatTraceTree(trace: AgentTrace): string {
  const header =
    `[trace ${trace.requestId || "(no-id)"}] ` +
    `stopReason=${trace.stopReason} completed=${trace.completed} ` +
    `${trace.steps.length} steps ${trace.totalDurationMs ?? "?"}ms`;

  const lines = trace.steps.map((step, i) => {
    // 最后一个 step 用 └─，其余用 ├─
    const branch = i === trace.steps.length - 1 ? " └─" : " ├─";
    const dur = step.durationMs != null ? `${step.durationMs}ms` : "?ms";

    if (step.type === "model") {
      // TS 在这里自动收窄成 ModelTraceStep，能安全访问 model 专属字段
      const wants =
        step.requestedToolCalls.length > 0
          ? `wants[${step.requestedToolCalls.map((t) => t.name).join(", ")}]`
          : "done";
      const text = step.textSummary.replace(/\n/g, " ").slice(0, 100);
      const budget = step.tokenBudget
        ? ` budget=${step.tokenBudget.spentAfter}/${step.tokenBudget.max}`
        : "";
      return `${branch} #${step.index} model (${dur}) text="${text}" -> ${wants}${budget}`;
    } else if (step.type === "tool") {
      // 这里收窄成 ToolTraceStep
      const chars = step.contentTruncated
        ? `${step.contentOriginalChars}→截断`
        : `${step.contentOriginalChars}chars`;
      return `${branch} #${step.index} tool  ${step.name} ok=${step.ok} ${dur} content(${chars})`;
    } else if (step.type === "context_compaction") {
      const method = step.method ? ` method=${step.method}` : "";
      return `${branch} #${step.index} compact (${dur}) ${step.beforeTokens}→${step.afterTokens} tok middle=${step.middleMessageCount}${method}`;
    } else if (step.type === "plan") {
      return `${branch} #${step.index} plan ${step.phase} ${step.status} goal="${step.goal.slice(0, 100)}"`;
    } else if (step.type === "retrieval") {
      return `${branch} #${step.index} retrieval ${step.phase} route=${step.route} required=${step.evidenceRequired ?? false} evidence=${step.evidenceCount ?? 0}`;
    } else if (step.type === "memory_consolidation") {
      return `${branch} #${step.index} memory_consolidation ${step.outcome.status} persisted=${step.outcome.persistedCount} candidates=${step.outcome.candidateDetails.length}`;
    }
    return `${branch} #${step.index} answer_validation ${step.report.status} groundedness=${step.report.groundedness.toFixed(2)}`;
  });

  return [header, ...lines].join("\n");
}
