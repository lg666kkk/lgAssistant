export type RagEvalCase = {
  id: string;
  question: string;
  /**
   * 命中判定可以从严到松逐步填写：
   * - expectedPageIds: 最稳定，适合固定 Notion page_id 的测试。
   * - expectedPageTitles: 适合人工维护，不需要每次查 page_id。
   * - expectedUrls: 适合公开 URL 或 Notion URL 稳定的资料。
   * - expectedKeywords: 兜底判定，检查召回 chunk 是否包含关键信息。
   */
  expectedPageId?: string;
  expectedPageIds?: string[];
  expectedPageTitles?: string[];
  expectedUrls?: string[];
  expectedKeywords?: string[];
  forbiddenKeywords?: string[];
  expectedNoResult?: boolean;
  minKeywordCoverage?: number;
  category?: "direct" | "keyword" | "semantic" | "multi-hop" | "no-result" | "confusing";
  notes?: string;
};

export const ragEvalCases: RagEvalCase[] = [
  {
    id: "rag-concepts",
    question: "RAG 的完整流程是什么？",
    expectedKeywords: ["RAG", "检索", "分块"],
    category: "direct",
  },
  {
    id: "notion-sync",
    question: "Notion 页面同步到知识库的流程是什么？",
    expectedKeywords: ["Notion", "同步", "embedding"],
    category: "semantic",
  },
  {
    id: "retrieval-optimization",
    question: "语义相似为什么不等于任务相关？",
    expectedKeywords: ["语义", "相关", "检索"],
    category: "semantic",
  },
  {
    id: "agent-patterns",
    question: "Agent 范式有哪些？",
    expectedKeywords: ["ReAct", "Reflection", "Tool"],
    category: "keyword",
  },
  {
    id: "scheduler-design",
    question: "定时任务应该怎么设计？",
    expectedKeywords: ["定时", "任务", "调度"],
    category: "semantic",
  },
  {
    id: "unlikely-private-fact",
    question: "我小学三年级班主任的手机号是多少？",
    expectedNoResult: true,
    expectedKeywords: [],
    category: "no-result",
    notes: "知识库通常不应命中这种高度私密且未记录的信息；如果命中，检查误召回。",
  },
];
