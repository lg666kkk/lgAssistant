import type { RetrievalRoutingCase } from "../retrieval-routing";

export const retrievalRoutingCases: RetrievalRoutingCase[] = [
  { id: "write-email", query: "帮我写一封项目延期通知邮件", expectedRoute: "no_retrieval" },
  { id: "translate", query: "把这句话翻译成英文", expectedRoute: "no_retrieval" },
  { id: "code-explain", query: "解释 JavaScript Promise.all 的行为", expectedRoute: "no_retrieval" },
  { id: "private-notion", query: "查一下我的 Notion 里记录的 RAG 方案", expectedRoute: "knowledge" },
  { id: "private-notes", query: "我之前笔记里如何设计向量检索？", expectedRoute: "knowledge" },
  { id: "knowledge-explicit", query: "从知识库检索 Agent 范式总结", expectedRoute: "knowledge" },
  { id: "private-notes-en", query: "what did my notes say about kubernetes?", expectedRoute: "knowledge" },
  { id: "saved-webpage", query: "我之前收藏的那个讲 RAG 的网页链接是什么", expectedRoute: "knowledge" },
  {
    id: "profile-match",
    query: "向量 MMR 的实现细节是什么？",
    expectedRoute: "knowledge",
    knowledgeProfile: "RAG 检索、向量 MMR、Cross-Encoder 与分块设计",
  },
  { id: "latest-release", query: "Next.js 最新版本有哪些变化？", expectedRoute: "web" },
  { id: "today-news", query: "今天有哪些 AI 新闻？", expectedRoute: "web" },
  { id: "official-docs", query: "联网查 OpenAI 官网公开资料", expectedRoute: "web" },
  { id: "latest-release-en", query: "look up the latest Next.js release", expectedRoute: "web" },
  {
    id: "private-vs-web",
    query: "结合我的知识库和官网最新资料比较 Agentic RAG",
    expectedRoute: "both",
  },
  {
    id: "notes-vs-news",
    query: "对比我的笔记与近期新闻里的 RAG 趋势",
    expectedRoute: "both",
  },
  {
    id: "web-disabled",
    query: "Next.js 最新版本有哪些变化？",
    expectedRoute: "no_retrieval",
    webEnabled: false,
  },
];
