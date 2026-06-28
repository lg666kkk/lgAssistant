export type RagEvalCase = {
  id: string;
  question: string;
  expectedPageId?: string;
  expectedKeywords?: string[];
};

export const ragEvalCases: RagEvalCase[] = [
  {
    id: "rag-concepts",
    question: "RAG 的完整流程是什么？",
    expectedKeywords: ["RAG", "检索", "分块"],
  },
  {
    id: "notion-sync",
    question: "Notion 页面同步到知识库的流程是什么？",
    expectedKeywords: ["Notion", "同步", "embedding"],
  },
  {
    id: "retrieval-optimization",
    question: "语义相似为什么不等于任务相关？",
    expectedKeywords: ["语义", "相关", "检索"],
  },
];
