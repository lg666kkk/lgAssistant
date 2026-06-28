import {
  type ToolDefinition,
  type ToolResult,
  defaultToolRuntimePolicy,
} from "./types";
import { tavily } from "@tavily/core";
export type WebSearchInput = {
  query: string;
  limit?: number;
  searchDepth?: "basic" | "advanced";
};

function parseInput(input: unknown): WebSearchInput {
  if (!input || typeof input !== "object") {
    return {
      query: "",
      limit: 5,
      searchDepth: "basic",
    };
  }
  const data = input as Record<string, unknown>;
  return {
    query: typeof data.query === "string" ? data.query : "",
    limit: typeof data.limit === "number" ? data.limit : 5,
    searchDepth:
      data.searchDepth === "advanced" || data.searchDepth === "basic"
        ? data.searchDepth
        : "basic",
  };
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "联网搜索公开网页信息，适合查询最新信息、新闻、版本变化、价格、政策等需要实时资料的问题。",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词或问题",
      },
      limit: {
        type: "number",
        description: "返回结果数量，默认 3，最多 5。除非用户要求深度研究，不要超过 5",
      },
      searchDepth: {
        type: "string",
        description: "搜索深度，默认 basic。只有深度研究或搜索结果不足时才用 advanced",
        enum: ["basic", "advanced"],
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 20,
    timeoutSeconds: 15,
    sideEffect: "external",
    concurrencyGroup: "web",
    maxConcurrency: 3,
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const { query, limit, searchDepth } = parseInput(input);
    if (!query.trim()) {
      return {
        ok: false,
        content: "搜索关键词不能为空",
      };
    }
    if (!process.env.TAVILY_API_KEY) {
      return {
        ok: false,
        content: "缺少环境变量 TAVILY_API_KEY",
        error: "Missing TAVILY_API_KEY",
      };
    }
    try {
      const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
      const response = await tvly.search(query, {
        maxResults: Math.min(limit ?? 3, 5),
        searchDepth: searchDepth || "basic",
      });
      const results = response.results || [];
      const content = results.length
        ? results
            .map((result, index) => {
              return `${index + 1}. ${result.title} 链接：${result.url} 摘要：${result.content}`;
            })
            .join("\n\n")
        : "没有找到相关网页搜索结果";
      console.log("web搜索结果", response);
      return {
        ok: true,
        content,
        data: {
          response,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: "联网搜索失败",
        error: error instanceof Error ? error.message : "Web search failed",
      };
    }
  },
};
