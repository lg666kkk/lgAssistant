import {
  IDENTITY_CONTENT,
  EVIDENCE_CITATION_POLICY,
} from "./policies";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

export type PromptSegmentKind = "identity" | "memory-operation" | "memory" | "retrieval-plan" | "tool-orchestration" | "evidence-policy" | "task-context" | "safety";

export type PromptSegment = {
  kind: PromptSegmentKind;
  title: string; // 给人看的段名，trace 详情页分块标题用
  content: string; // 段正文；空内容的段不会被构造出来
  priority: number;       // 越高越重要
  tokenBudget?: number;   // 这个段最多允许多少 token
  source?: string;        // memory / system / runtime / user
  trust?: "trusted" | "user" | "external";
  dynamic?: boolean;      // 是否每轮变化
  metadata?: Record<string, unknown>; // trace 展示用的结构化调试信息
};

export type BuildSegmentsInput = {
  includeIdentity?: boolean; // 是否注入基础身份段，默认 true
  userMessage?: string; // 当前轮用户消息，用来约束模型只回答最新问题
  memoryOperation?: string; // 已执行的记忆写入/失效结果，属于可信 runtime 状态
  memory?: string; // recallForPrompt 的返回（已是成段文本），空串则不构造记忆段
  knowledge?: string; // RAG 知识库召回内容，空串则不构造知识库段
  knowledgeMetadata?: Record<string, unknown>; // RAG debug summary，写进 trace
  webSearchEnabled?: boolean;
  toolOrchestration?: string;
  retrievalPlan?: RetrievalPlan;
};

/**
 * 按输入构造段数组。顺序即注入顺序：身份 → 记忆 → 策略。
 * 空内容的段直接跳过，不产出。
 */
export function buildSegments(input: BuildSegmentsInput): PromptSegment[] {
  const segments: PromptSegment[] = [];

  if (input.includeIdentity !== false) {
    segments.push({
      kind: "identity",
      title: "身份",
      content: IDENTITY_CONTENT,
      priority: 100,
      tokenBudget: 200,
      source: "system",
      dynamic: false,
    });
  }

  const memoryOperation = input.memoryOperation?.trim();
  if (memoryOperation) {
    segments.push({
      kind: "memory-operation",
      title: "记忆操作结果",
      content: memoryOperation,
      priority: 108,
      tokenBudget: 220,
      source: "runtime",
      trust: "trusted",
      dynamic: true,
    });
  }

  const memory = input.memory?.trim();
  if (memory) {
    segments.push({
      kind: "memory",
      title: "记忆",
      content: memory,
      priority: 90,
      tokenBudget: 500,
      source: "memory",
      trust: "external",
      dynamic: false,
    });
  }

  if (input.retrievalPlan) {
    const plan = input.retrievalPlan;
    segments.push({
      kind: "retrieval-plan",
      title: "显式检索计划",
      content: [
        `route=${plan.route}`,
        `reason=${plan.reason}`,
        `freshnessRequired=${plan.freshnessRequired === true}`,
        `evidenceRequired=${plan.evidenceRequired}`,
        `maxAttempts=${plan.maxAttempts}`,
        `indexVersion=${plan.indexVersion}`,
        ...plan.steps.map((step) =>
          `${step.id}: source=${step.source}; purpose=${step.purpose}`,
        ),
        plan.route === "no_retrieval"
          ? "当前路由未预选检索；若进一步判断用户明确需要个人知识或实时公开证据，可把检索工具作为一次受限 fallback。"
          : "优先使用该 route 对应的检索工具。证据不足时最多按计划重试一次，不得自行无限改写或降低阈值。",
        // route=knowledge 时 Web 工具依然可见（用户已开启联网），必须说清先后顺序，
        // 否则模型会把“可用”读成“可以先用”，绕过知识库直接联网。
        ...(plan.route === "knowledge" && input.webSearchEnabled
          ? ["用户本轮已开启联网，Web 检索工具可用但仅作兜底：必须先查个人知识库，只有知识库无结果、证据明显过期或用户后续明确要求公开来源时，才允许改用 Web 检索。"]
          : []),
      ].join("\n"),
      priority: 96,
      tokenBudget: 520,
      source: "runtime",
      trust: "trusted",
      dynamic: true,
      metadata: {
        type: "retrieval_plan",
        ...plan,
      },
    });
    if (plan.route !== "no_retrieval") {
      segments.push({
        kind: "evidence-policy",
        title: "证据引用策略",
        content: EVIDENCE_CITATION_POLICY,
        priority: 97,
        tokenBudget: 360,
        source: "system",
        dynamic: false,
      });
    }
  }

  const toolOrchestration = input.toolOrchestration?.trim();
  if (input.webSearchEnabled && toolOrchestration) {
    // 这段文本由当前 registry + RetrievalPlan 动态生成，不再维护一份写死工具名的
    // WEB_SEARCH_CONTENT。它帮助模型首次就按正确顺序调用；Runtime 仍独立强制依赖。
    segments.push({
      kind: "tool-orchestration",
      title: "工具编排策略",
      content: toolOrchestration,
      priority: 98,
      tokenBudget: 240,
      source: "runtime",
      trust: "trusted",
      dynamic: true,
    });
  }

  const knowledge = input.knowledge?.trim();
  if (knowledge) {
    segments.push({
      kind: "task-context",
      title: "知识库检索",
      content: knowledge,
      priority: 95,
      tokenBudget: 1200,
      source: "knowledge",
      trust: "external",
      dynamic: true,
      metadata: input.knowledgeMetadata,
    });
  }

  return segments;
}
