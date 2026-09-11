import type { UserSearchProvider } from "./types";

export const SEARCH_PROVIDER_DEFINITIONS: Array<Omit<UserSearchProvider, "apiKeyConfigured" | "apiKeyHint" | "source" | "enabled">> = [
  {
    id: "tavily",
    name: "Tavily",
    description: "面向 Agent 和 RAG 的搜索 API，直接提供适合模型引用的网页摘要。",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  },
  {
    id: "exa",
    name: "Exa",
    description: "语义搜索和相似内容发现更强，适合研究、论文和深度资料检索。",
    docsUrl: "https://exa.ai/docs/reference/search",
  },
  {
    id: "brave",
    name: "Brave Search",
    description: "基于自有网页索引，适合通用网页、新闻和强调时效性的搜索。",
    docsUrl: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started",
  },
];

