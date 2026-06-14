import {
  IDENTITY_CONTENT,
  SEARCH_QUERY_POLICY,
  WEB_SEARCH_CONTENT,
} from "./policies";

export type PromptSegmentKind = "identity" | "memory" | "web-search-policy" | "search-query-policy" | "task-context" | "safety";

export type PromptSegment = {
  kind: PromptSegmentKind;
  title: string; // 给人看的段名，trace 详情页分块标题用
  content: string; // 段正文；空内容的段不会被构造出来
  priority: number;       // 越高越重要
  tokenBudget?: number;   // 这个段最多允许多少 token
  source?: string;        // memory / system / runtime / user
  dynamic?: boolean;      // 是否每轮变化
};

export type BuildSegmentsInput = {
  includeIdentity?: boolean; // 是否注入基础身份段，默认 true
  memory?: string; // recallForPrompt 的返回（已是成段文本），空串则不构造记忆段
  webSearchEnabled?: boolean; // 开启联网搜索 → 构造策略段
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
