import { type ToolDefinition, type ToolResult, defaultToolRuntimePolicy, type ToolExecutionContext } from "./types";
import { ragConfig } from "@/lib/platform/config";
import {
  RAGRetriever,
  type RAGSearchResponse,
  type SearchResult,
} from "@/lib/knowledge/retriever";
import {
  countTokensFromText,
  truncateTextByTokens,
} from "@/lib/agent/runtime/tokenizer";
type SearchNoteInput = {
  query: string;
  limit: number;
};

type SearchNotesRetriever = Pick<RAGRetriever, "searchWithDebug">;

type RagSearchAttempt = {
  label: "primary" | "bounded_fallback";
  threshold: number;
  returnedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  topEvidenceScore: number | null;
  debug: RAGSearchResponse["debug"];
  topResults: ReturnType<typeof buildRagTopResults>;
};

function parseInput(input: unknown): SearchNoteInput {
  if (!input || typeof input !== "object") {
    return { query: "", limit: ragConfig.maxResults };
  }
  const value = input as Record<string, unknown>;
  const requestedLimit = typeof value.limit === "number"
    ? Math.floor(value.limit)
    : ragConfig.maxResults;

  return {
    query: typeof value.query === "string" ? value.query : "",
    limit: Math.max(1, Math.min(ragConfig.maxResults, requestedLimit)),
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
    rrfScore: result.rrfScore,
    ruleRerankScore: result.ruleRerankScore,
    crossEncoderScore: result.crossEncoderScore,
    rerankScore: result.rerankScore ?? result.combinedScore,
    retrievalSources: result.retrievalSources,
    headingPath: result.headingPath,
    excerpt: result.content.replace(/\s+/g, " ").trim().slice(0, 240),
  }));
}

function evidenceScore(result: SearchResult) {
  return result.rerankScore ?? result.combinedScore;
}

function buildAttempt(
  label: RagSearchAttempt["label"],
  response: RAGSearchResponse,
  acceptedResults: SearchResult[],
): RagSearchAttempt {
  return {
    label,
    threshold: response.debug.matchThreshold,
    returnedCount: response.results.length,
    acceptedCount: acceptedResults.length,
    rejectedCount: response.results.length - acceptedResults.length,
    topEvidenceScore:
      response.results.length > 0 ? evidenceScore(response.results[0]) : null,
    debug: response.debug,
    topResults: buildRagTopResults(response.results),
  };
}

function fallbackThreshold(primaryThreshold: number) {
  return Math.max(
    0.01,
    Math.min(
      ragConfig.fallbackSimilarityThreshold,
      primaryThreshold - 0.01,
    ),
  );
}

function acceptedFallbackResults(results: SearchResult[]) {
  return results.filter(
    (result) =>
      result.similarity >= ragConfig.fallbackSimilarityThreshold &&
      evidenceScore(result) >= ragConfig.fallbackMinEvidenceScore,
  );
}

function buildModelContext(results: SearchResult[]) {
  const separator = "\n\n---\n\n";
  const separatorTokens = countTokensFromText(separator);
  const seenParents = new Set<string>();
  const parts: string[] = [];
  let remainingTokens = ragConfig.maxContextTokens;
  let contextTruncated = false;
  let dedupedParentCount = 0;

  for (const result of results) {
    const parentKey = result.parentKey ?? result.id;
    if (seenParents.has(parentKey)) {
      dedupedParentCount++;
      continue;
    }
    seenParents.add(parentKey);

    const heading = result.headingPath.length > 0
      ? `\n位置：${result.headingPath.join(" / ")}`
      : "";
    const scores = [
      `相似度=${result.similarity.toFixed(3)}`,
      result.rrfScore !== undefined ? `RRF=${result.rrfScore.toFixed(3)}` : undefined,
      result.crossEncoderScore !== undefined
        ? `CrossEncoder=${result.crossEncoderScore.toFixed(3)}`
        : undefined,
    ].filter(Boolean).join(" / ");
    const header = `[${parts.length + 1}] ${result.pageTitle}${heading}\n链接：${result.pageUrl}\n分数：${scores}\n`;
    const prefixTokens = (parts.length > 0 ? separatorTokens : 0) + countTokensFromText(header);
    const availableContentTokens = remainingTokens - prefixTokens;
    if (availableContentTokens <= 0) {
      contextTruncated = true;
      break;
    }

    const sourceContent = result.parentContent ?? result.content;
    const truncated = truncateTextByTokens(sourceContent, availableContentTokens);
    if (!truncated.content.trim()) {
      contextTruncated = true;
      break;
    }

    const part = `${header}${truncated.content}`;
    const partTokens = countTokensFromText(part);
    remainingTokens -= partTokens + (parts.length > 0 ? separatorTokens : 0);
    parts.push(part);
    contextTruncated ||= truncated.truncated;

    if (remainingTokens <= 0) break;
  }

  return {
    content: parts.join(separator),
    tokenCount: ragConfig.maxContextTokens - Math.max(0, remainingTokens),
    sourceCount: parts.length,
    contextTruncated,
    dedupedParentCount,
  };
}

function sanitizeResults(results: SearchResult[]) {
  return results.map((result) => {
    const {
      embedding: _embedding,
      parentContent: _parentContent,
      ...safeResult
    } = result;
    if (!safeResult.metadata) return safeResult;

    const {
      parent_content: _parentContentMetadata,
      ...safeMetadata
    } = safeResult.metadata;
    return {
      ...safeResult,
      metadata: safeMetadata,
    };
  });
}

const BASE_SEARCH_NOTES_DESCRIPTION =
  "在用户的个人知识库（Notion 笔记、文档、资料）中检索内容。只有在用户明确要求查询个人知识库/笔记/文档，或当前问题与工具描述附带的知识库画像高度匹配时，才调用本工具。不要因为泛泛的事实问题、代码问题、闲聊、计算、实时公开信息查询而调用。它只能查到用户私有内容，查不到公开网络信息；公开或实时信息请用 web_search。若问题同时涉及个人资料和实时/公开信息，可与 web_search 一起调用，各取所长。";

export function createSearchNotesTool(options: {
  knowledgeProfile?: string;
  retriever?: SearchNotesRetriever;
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
        description: "脱离代词也能独立理解的搜索问题；多轮追问要补全被指代的实体",
      },
      limit: {
        type: "number",
        description: `返回结果数量，硬上限 ${ragConfig.maxResults}`,
        default: ragConfig.maxResults,
        minimum: 1,
        maximum: ragConfig.maxResults,
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
      const retriever = options.retriever ?? new RAGRetriever();
      const attempts: RagSearchAttempt[] = [];
      let usedFallback = false;
      let response = await retriever.searchWithDebug(query, {
        matchThreshold: ragConfig.similarityThreshold,
        matchCount: limit,
        userId: context?.userId,
        conversationContext: context?.conversationContext,
        enableMmr: true,
        enableQueryRewrite: true,
        enableRerank: true,
      });
      let results = response.results;
      attempts.push(buildAttempt("primary", response, results));

      if (results.length === 0) {
        usedFallback = true;
        response = await retriever.searchWithDebug(query, {
          matchThreshold: fallbackThreshold(ragConfig.similarityThreshold),
          matchCount: Math.min(
            limit,
            ragConfig.fallbackMaxResults,
          ),
          userId: context?.userId,
          conversationContext: context?.conversationContext,
          enableMmr: true,
          enableQueryRewrite: true,
          enableRerank: true,
        });
        results = acceptedFallbackResults(response.results);
        attempts.push(buildAttempt("bounded_fallback", response, results));
      }

      if (results.length === 0) {
        return {
          ok: true,
          content: "没有找到相关笔记",
          data: {
            query,
            results: [],
            debug: response.debug,
            attempts,
            usedFallback,
          },
          metadata: {
            rag: response.debug,
            ragReturnedCount: 0,
            ragQuery: query,
            ragTopResults: [],
            ragUsedFallback: usedFallback,
            ragFallbackReason: usedFallback ? "primary_no_results" : undefined,
            ragAttempts: attempts,
          },
        };
      }
      const modelContext = buildModelContext(results);
      const safeResults = sanitizeResults(results);
      return {
        ok: true,
        content: modelContext.content,
        data: {
          query,
          results: safeResults,
          debug: response.debug,
          attempts,
          usedFallback,
          context: modelContext,
        },
        metadata: {
          rag: response.debug,
          ragReturnedCount: results.length,
          ragQuery: query,
          ragTopResults: buildRagTopResults(results),
          ragUsedFallback: usedFallback,
          ragFallbackReason: usedFallback ? "primary_no_results" : undefined,
          ragAttempts: attempts,
          ragContextTokens: modelContext.tokenCount,
          ragContextSourceCount: modelContext.sourceCount,
          ragContextTruncated: modelContext.contextTruncated,
          ragParentContextsDeduped: modelContext.dedupedParentCount,
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
