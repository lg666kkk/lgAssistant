import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy } from "./types";
import { ragConfig } from "@/lib/config";
import { RAGRetriever } from "@/lib/server/retriever";
type SearchNoteInput = {
  query: string;
  limit?: number;
};

function parseInput(input: unknown): SearchNoteInput {
  if (!input || typeof input !== "object") {
    return { query: "", limit: 10 };
  }
  const value = input as Record<string, unknown>;

  return {
    query: typeof value.query === "string" ? value.query : "",
    limit: typeof value.limit === "number" ? value.limit : 10,
  };
}

export const searchNotesTool: ToolDefinition = {
  name: "search_notes",
  description: "在知识库中搜索笔记内容",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词",
      },
      limit: {
        type: "number",
        description: "返回结果数量",
        default: 10,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  runtime: {
    ...defaultToolRuntimePolicy,
    rateLimit: 20,
  },
  riskLevel: "safe",
  execute: async (input: unknown): Promise<ToolResult> => {
    const { query, limit } = parseInput(input);
    if (!query.trim()) {
      return {
        ok: false,
        content: "缺少搜索关键词",
        error: "Missing query",
      };
    }
    try {
      const retriever = new RAGRetriever();
      const results = await retriever.search(query, {
        matchThreshold: ragConfig.similarityThreshold,
        matchCount: limit ?? ragConfig.maxResults,
      });
      if (results.length === 0) {
        return {
          ok: true,
          content: "没有找到相关笔记",
          data: {
            query,
            results: [],
          },
        };
      }
      const content = results
        .map(
          (result, index) =>
            `[${index + 1}] ${result.pageTitle}\n${result.content}`,
        )
        .join("\n\n---\n\n");
      return {
        ok: true,
        content,
        data: {
          query,
          results,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: "搜索笔记失败",
        error: error instanceof Error ? error.message : "Search notes failed",
      };
    }
  },
};
