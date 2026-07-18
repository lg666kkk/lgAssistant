import {
  IDENTITY_CONTENT,
  EVIDENCE_CITATION_POLICY,
  KNOWLEDGE_SEARCH_POLICY,
  SEARCH_QUERY_POLICY,
  WEB_SEARCH_CONTENT,
} from "./policies";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

export type PromptSegmentKind = "identity" | "memory" | "retrieval-plan" | "knowledge-search-policy" | "web-search-policy" | "search-query-policy" | "evidence-policy" | "task-context" | "safety";

export type PromptSegment = {
  kind: PromptSegmentKind;
  title: string; // 给人看的段名，trace 详情页分块标题用
  content: string; // 段正文；空内容的段不会被构造出来
  priority: number;       // 越高越重要
  tokenBudget?: number;   // 这个段最多允许多少 token
  source?: string;        // memory / system / runtime / user
  dynamic?: boolean;      // 是否每轮变化
  metadata?: Record<string, unknown>; // trace 展示用的结构化调试信息
};

export type BuildSegmentsInput = {
  includeIdentity?: boolean; // 是否注入基础身份段，默认 true
  userMessage?: string; // 当前轮用户消息，用来约束模型只回答最新问题
  memory?: string; // recallForPrompt 的返回（已是成段文本），空串则不构造记忆段
  knowledge?: string; // RAG 知识库召回内容，空串则不构造知识库段
  knowledgeMetadata?: Record<string, unknown>; // RAG debug summary，写进 trace
  webSearchEnabled?: boolean; // 开启联网搜索 → 构造策略段
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

  const userMessage = input.userMessage?.trim();
  if (userMessage) {
    segments.push({
      kind: "task-context",
      title: "当前问题",
      content: [
        "当前轮必须优先回答下面这一条用户消息：",
        userMessage,
        "",
        "历史对话只作为背景使用；不要主动逐个回答历史里的旧问题，也不要把旧回答重新输出，除非当前用户明确要求回顾或总结历史。",
      ].join("\n"),
      priority: 110,
      tokenBudget: 500,
      source: "user",
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
      dynamic: false,
    });
  }

  segments.push({
    kind: "knowledge-search-policy",
    title: "知识库检索策略",
    content: KNOWLEDGE_SEARCH_POLICY,
    priority: 85,
    tokenBudget: 360,
    source: "system",
    dynamic: false,
  });

  if (input.retrievalPlan) {
    const plan = input.retrievalPlan;
    segments.push({
      kind: "retrieval-plan",
      title: "显式检索计划",
      content: [
        `route=${plan.route}`,
        `reason=${plan.reason}`,
        `evidenceRequired=${plan.evidenceRequired}`,
        `maxAttempts=${plan.maxAttempts}`,
        `indexVersion=${plan.indexVersion}`,
        ...plan.steps.map((step) =>
          `${step.id}: source=${step.source}; query=${step.query}; filters=${JSON.stringify(step.filters ?? {})}`,
        ),
        plan.route === "no_retrieval"
          ? "当前路由未预选检索；若进一步判断用户明确需要个人知识或实时公开证据，可把检索工具作为一次受限 fallback。"
          : "优先使用该 route 对应的检索工具。证据不足时最多按计划重试一次，不得自行无限改写或降低阈值。",
      ].join("\n"),
      priority: 96,
      tokenBudget: 520,
      source: "runtime",
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

  const knowledge = input.knowledge?.trim();
  if (knowledge) {
    segments.push({
      kind: "task-context",
      title: "知识库检索",
      content: knowledge,
      priority: 95,
      tokenBudget: 1200,
      source: "knowledge",
      dynamic: true,
      metadata: input.knowledgeMetadata,
    });
  }

  if (input.webSearchEnabled) {
    segments.push({
      kind: "search-query-policy",
      title: "搜索查询策略",
      content: SEARCH_QUERY_POLICY,
      priority: 80,
      tokenBudget: 300,
      source: "system",
      dynamic: false,
    });
    segments.push({
      kind: "web-search-policy",
      title: "联网搜索策略",
      content: WEB_SEARCH_CONTENT,
      priority: 70,
      tokenBudget: 400,
      source: "system",
      dynamic: false,
    });
  }

  return segments;
}
