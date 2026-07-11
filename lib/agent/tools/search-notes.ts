import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy, type ToolExecutionContext } from "./types";
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

function buildRagTopResults(results: Awaited<ReturnType<RAGRetriever["searchWithDebug"]>>["results"]) {
  return results.slice(0, 5).map((result, index) => ({
    rank: index + 1,
    id: result.id,
    pageId: result.pageId,
    pageTitle: result.pageTitle,
    pageUrl: result.pageUrl,
    similarity: result.similarity,
    vectorScore: result.vectorScore,
    keywordScore: result.keywordScore,
    rerankScore: result.rerankScore ?? result.combinedScore,
    retrievalSources: result.retrievalSources,
    headingPath: result.headingPath,
    excerpt: result.content.replace(/\s+/g, " ").trim().slice(0, 240),
  }));
}

const BASE_SEARCH_NOTES_DESCRIPTION =
  "在用户的个人知识库（Notion 笔记、文档、资料）中检索内容。只有在用户明确要求查询个人知识库/笔记/文档，或当前问题与工具描述附带的知识库画像高度匹配时，才调用本工具。不要因为泛泛的事实问题、代码问题、闲聊、计算、实时公开信息查询而调用。它只能查到用户私有内容，查不到公开网络信息；公开或实时信息请用 web_search。若问题同时涉及个人资料和实时/公开信息，可与 web_search 一起调用，各取所长。";

export function createSearchNotesTool(options: {
  knowledgeProfile?: string;
} = {}): ToolDefinition {
  return {
  name: "search_notes",
  description: options.knowledgeProfile
    ? `${BASE_SEARCH_NOTES_DESCRIPTION}\n\n${options.knowledgeProfile}`
    : BASE_SEARCH_NOTES_DESCRIPTION,
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
    sideEffect: "read",
    concurrencyGroup: "knowledge",
    maxConcurrency: 4,
  },
  riskLevel: "safe",
  execute: async (input: unknown, context?: ToolExecutionContext): Promise<ToolResult> => {
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
      let response = await retriever.searchWithDebug(query, {
        matchThreshold: ragConfig.similarityThreshold,
        matchCount: limit ?? ragConfig.maxResults,
        userId: context?.userId,
        enableMmr: true,
        enableQueryRewrite: true,
        enableRerank: true,
      });
      let results = response.results;

      if (results.length === 0) {
        response = await retriever.searchWithDebug(query, {
          matchThreshold: 0,
          matchCount: limit ?? ragConfig.maxResults,
          userId: context?.userId,
          enableMmr: true,
          enableQueryRewrite: true,
          enableRerank: true,
        });
        results = response.results;
      }

      if (results.length === 0) {
        return {
          ok: true,
          content: "没有找到相关笔记",
          data: {
            query,
            results: [],
            debug: response.debug,
          },
          metadata: {
            rag: response.debug,
            ragReturnedCount: 0,
            ragQuery: query,
            ragTopResults: [],
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
          debug: response.debug,
        },
        metadata: {
          rag: response.debug,
          ragReturnedCount: results.length,
          ragQuery: query,
          ragTopResults: buildRagTopResults(results),
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
}

export const searchNotesTool: ToolDefinition = createSearchNotesTool();
