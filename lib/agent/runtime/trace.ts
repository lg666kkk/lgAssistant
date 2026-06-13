import { truncateToolContent } from "./budget";
import type { AgentLoopMetrics, AgentLoopStopReason } from "./index";

export type TraceStepBase = {
  index: number; // model/tool 共享的递增序号，用来还原真实时间线
  startedAt: number; // Date.now() 时间戳
  durationMs?: number;
};

export type ModelTraceStep = TraceStepBase & {
  type: "model";
  textSummary: string; // 模型这轮吐的文本（截断后的摘要）
  textTruncated: boolean;
  textOriginalChars: number;
  requestedToolCalls: Array<{ name: string; id: string; input: unknown }>; // 这轮想调哪些工具
  estimatedContextTokens: number; // 复用 loop 本轮已算的值
  usage?: { inputTokens?: number; outputTokens?: number }; // 模型返回的真实 token，有就填
  // 上下文工程可观测性核心：这轮注入给模型的 system prompt（截断后）。
  // 让 trace 详情页能回答「这次到底喂了什么上下文」。整个 loop 的 system 不变，
  // 但仍逐 step 记录，方便单看任意一步就知道当时的上下文。
  systemPrompt?: string;
  systemPromptTruncated?: boolean;
  systemPromptOriginalChars?: number;
  // 段化后的注入结构（身份/记忆/策略…）。详情页优先按段分块展示，
  // 没有时回退到 systemPrompt 整段。旧 trace 没有此字段，前端兼容处理。
  systemSegments?: Array<{ kind: string; title: string; content: string }>;
};

export type ToolTraceStep = TraceStepBase & {
  type: "tool";
  name: string;
  toolCallId?: string;
  input: unknown;
  ok: boolean;
  contentSummary: string; // 工具结果（截断后的摘要）
  contentTruncated: boolean;
  contentOriginalChars: number;
  error?: string;
  costPerUse: number;
};

export type TraceStep = ModelTraceStep | ToolTraceStep; // 判别联合

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
      return `${branch} #${step.index} model (${dur}) text="${text}" -> ${wants}`;
    } else {
      // 这里收窄成 ToolTraceStep
      const chars = step.contentTruncated
        ? `${step.contentOriginalChars}→截断`
        : `${step.contentOriginalChars}chars`;
      return `${branch} #${step.index} tool  ${step.name} ok=${step.ok} ${dur} content(${chars})`;
    }
  });

  return [header, ...lines].join("\n");
}
