import {
  createEvidenceBundle,
  createKnowledgeEvidenceItems,
  summarizeEvidenceBundle,
} from "@/lib/agent/rag/evidence";
import { gradeKnowledgeEvidence } from "@/lib/agent/rag/evidence-grader";
import { QueryResultCache } from "@/lib/agent/rag/query-cache";
import { createRetryQuery } from "@/lib/agent/rag/retrieval-router";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
  type RetrievalAttempt,
  type RetrievalFilters,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import {
  countTokensFromText,
  truncateTextByTokens,
} from "@/lib/agent/runtime/tokenizer";
import {
  RAGRetriever,
  RAGRetrievalTimeoutError,
  type RAGSearchResponse,
  type SearchResult,
} from "@/lib/knowledge/retriever";
import { extractNotionPageId } from "@/lib/knowledge/notion-page-id";
import { ragConfig } from "@/lib/platform/config";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

type SearchNoteInput = {
  query: string;
  limit: number;
  filters?: RetrievalFilters;
};

type SearchNotesRetriever = Pick<RAGRetriever, "searchWithDebug">;

// 一次 search_notes 可能包含两次完整 RAG 召回，不能沿用轻量工具的 30 秒默认值。
const SEARCH_NOTES_TIMEOUT_SECONDS = 45;
const SEARCH_NOTES_INTERNAL_BUDGET_MS = 40_000;
const SEARCH_NOTES_MAX_ATTEMPT_MS = 25_000;
const SEARCH_NOTES_RETRY_RESERVE_MS = 12_000;
const SEARCH_NOTES_COMPLETION_RESERVE_MS = 3_000;

class SearchNotesTimeoutError extends Error {
  constructor(
    readonly attempt: number,
    readonly timeoutMs: number,
  ) {
    super(`知识库第 ${attempt} 次检索在 ${Math.ceil(timeoutMs / 1000)} 秒内未完成`);
    this.name = "SearchNotesTimeoutError";
  }
}

type RagSearchAttempt = RetrievalAttempt & {
  threshold: number;
  returnedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  topEvidenceScore: number | null;
  debug: RAGSearchResponse["debug"];
  topResults: ReturnType<typeof buildRagTopResults>;
};

const searchResultCache = new QueryResultCache<RAGSearchResponse>();

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
    filters: parseFilters(value.filters),
  };
}

function parseFilters(value: unknown): RetrievalFilters | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const filters = value as Record<string, unknown>;
  const timeRange = filters.timeRange && typeof filters.timeRange === "object"
    ? filters.timeRange as Record<string, unknown>
    : undefined;
  const parsed: RetrievalFilters = {
    pageIds: Array.isArray(filters.pageIds)
      ? filters.pageIds
          .filter((item): item is string => typeof item === "string")
          .flatMap((item) => {
            const pageId = extractNotionPageId(item);
            return pageId ? [pageId] : [];
          })
          .slice(0, 20)
      : undefined,
    titleContains: typeof filters.titleContains === "string"
      ? filters.titleContains.trim().slice(0, 120)
      : undefined,
    sourceTypes: Array.isArray(filters.sourceTypes)
      ? filters.sourceTypes.filter(
          (item): item is "notion" | "document" =>
            item === "notion" || item === "document",
        )
      : undefined,
    timeRange: timeRange
      ? {
          from: typeof timeRange.from === "string" ? timeRange.from : undefined,
          to: typeof timeRange.to === "string" ? timeRange.to : undefined,
          label: typeof timeRange.label === "string" ? timeRange.label : undefined,
        }
      : undefined,
  };
  return Object.values(parsed).some(Boolean) ? parsed : undefined;
}

function mergeFilters(
  planned?: RetrievalFilters,
  requested?: RetrievalFilters,
): RetrievalFilters | undefined {
  if (!planned) return requested;
  if (!requested) return planned;
  return {
    ...requested,
    ...planned,
    timeRange: planned.timeRange || requested.timeRange
      ? { ...requested.timeRange, ...planned.timeRange }
      : undefined,
  };
}

function buildRagTopResults(results: SearchResult[]) {
  const evidenceByChunk = new Map(
    createKnowledgeEvidenceItems(results).map((item) => [item.chunkId, item.evidenceId]),
  );
  return results.slice(0, 5).map((result, index) => ({
    rank: index + 1,
    id: result.id,
    evidenceId: evidenceByChunk.get(result.id),
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

function buildAttempt(input: {
  attempt: number;
  query: string;
  response: RAGSearchResponse;
  grade: RagSearchAttempt["grade"];
  cacheHit: boolean;
  rewriteReason?: string;
}): RagSearchAttempt {
  return {
    attempt: input.attempt,
    source: "knowledge",
    query: input.query,
    threshold: input.response.debug.matchThreshold,
    resultCount: input.response.results.length,
    returnedCount: input.response.results.length,
    acceptedCount: input.grade.acceptedEvidenceIds.length,
    rejectedCount: Math.max(
      0,
      input.response.results.length - input.grade.acceptedEvidenceIds.length,
    ),
    topEvidenceScore: input.grade.topScore,
    cacheHit: input.cacheHit,
    rewriteReason: input.rewriteReason,
    grade: input.grade,
    timings: input.response.debug.timings,
    debug: input.response.debug,
    topResults: buildRagTopResults(input.response.results),
  };
}

function buildModelContext(results: SearchResult[], bundle: EvidenceBundle) {
  const separator = "\n\n---\n\n";
  const separatorTokens = countTokensFromText(separator);
  const gradeNotice = bundle.grade.sufficient
    ? ""
    : "证据提示：以下候选通过了最低相关性要求，但整体证据充分性不足。只能保守引用，并明确说明不确定性。";
  const evidenceByChunk = new Map(
    bundle.evidences.map((item) => [item.chunkId, item]),
  );
  const seenParents = new Set<string>();
  const parts: string[] = [];
  let remainingTokens = ragConfig.maxContextTokens
    - countTokensFromText(gradeNotice)
    - (gradeNotice ? separatorTokens : 0);
  let contextTruncated = false;
  let dedupedParentCount = 0;

  for (const result of results) {
    const evidence = evidenceByChunk.get(result.id);
    if (!evidence) continue;
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
    const header = `[${evidence.evidenceId}] ${result.pageTitle}${heading}\n链接：${result.pageUrl}\n分数：${scores}\n`;
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

  const content = [gradeNotice, ...parts].filter(Boolean).join(separator);
  return {
    content,
    tokenCount: countTokensFromText(content),
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
    return { ...safeResult, metadata: safeMetadata };
  });
}

function plannedQueries(query: string, plan?: RetrievalPlan) {
  const queries = new Set([query.trim()]);
  for (const step of plan?.steps ?? []) {
    if (step.source === "knowledge" && step.query.trim()) queries.add(step.query.trim());
  }
  return Array.from(queries).filter(Boolean).slice(0, plan?.maxAttempts ?? 2);
}

function mergeSearchResults(current: SearchResult[], incoming: SearchResult[]) {
  const byId = new Map(current.map((result) => [result.id, result]));
  for (const result of incoming) {
    const existing = byId.get(result.id);
    if (!existing || evidenceScore(result) > evidenceScore(existing)) {
      byId.set(result.id, result);
    }
  }
  return Array.from(byId.values())
    .sort((left, right) => evidenceScore(right) - evidenceScore(left))
    .slice(0, ragConfig.maxCandidates);
}

function evidenceScore(result: SearchResult) {
  return Math.max(
    result.crossEncoderScore ?? 0,
    result.rerankScore ?? result.combinedScore,
    result.similarity,
    result.keywordScore,
  );
}

async function withSearchAttemptTimeout<T>(input: {
  promise: Promise<T>;
  attempt: number;
  timeoutMs: number;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new SearchNotesTimeoutError(input.attempt, input.timeoutMs));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const BASE_SEARCH_NOTES_DESCRIPTION =
  "在用户个人知识库中检索内容。调用受显式 Retrieval Router、Query Planner 和 Evidence Grader 约束；最多执行两次同阈值 query。会回传通过最低接受线的证据并标记整体充分性，回答时使用 [evidenceId] 引用。公开实时信息请使用 web_search。";

export function createSearchNotesTool(options: {
  knowledgeProfile?: string;
  retrievalPlan?: RetrievalPlan;
  retriever?: SearchNotesRetriever;
  cache?: QueryResultCache<RAGSearchResponse>;
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
          description: "脱离代词也能独立理解的搜索问题",
        },
        limit: {
          type: "number",
          description: `返回结果数量，硬上限 ${ragConfig.maxResults}`,
          default: ragConfig.maxResults,
          minimum: 1,
          maximum: ragConfig.maxResults,
        },
        filters: {
          type: "object",
          description: "可选页面、标题和时间范围过滤条件",
          properties: {
            pageIds: { type: "array", items: { type: "string" } },
            titleContains: { type: "string" },
            sourceTypes: {
              type: "array",
              items: { type: "string", enum: ["notion", "document"] },
            },
            timeRange: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    runtime: {
      ...defaultToolRuntimePolicy,
      rateLimit: 20,
      // 检索可包含 embedding、双路召回和条件重排，允许内部预算返回可诊断错误。
      timeoutSeconds: SEARCH_NOTES_TIMEOUT_SECONDS,
      sideEffect: "read",
      concurrencyGroup: "knowledge",
      maxConcurrency: 4,
    },
    riskLevel: "safe",
    execute: async (
      input: unknown,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      const parsed = parseInput(input);
      if (!parsed.query.trim()) {
        return {
          ok: false,
          content: "缺少搜索关键词",
          error: "Missing query",
        };
      }

      try {
        const retriever = options.retriever ?? new RAGRetriever();
        const cache = options.cache ?? searchResultCache;
        const queries = plannedQueries(parsed.query, options.retrievalPlan);
        const planFilters = options.retrievalPlan?.steps.find(
          (step) => step.source === "knowledge",
        )?.filters;
        const filters = mergeFilters(planFilters, parsed.filters);
        const attempts: RagSearchAttempt[] = [];
        let mergedResults: SearchResult[] = [];
        let lastResponse: RAGSearchResponse | undefined;
        let finalGrade = gradeKnowledgeEvidence(parsed.query, [], []);
        const maxAttempts = options.retrievalPlan?.maxAttempts ?? 2;
        const searchStartedAt = Date.now();

        for (let index = 0; index < maxAttempts; index++) {
          const planned = queries[index];
          const retry = index > 0 && !planned && options.retrievalPlan
            ? createRetryQuery(options.retrievalPlan, queries[index - 1] ?? parsed.query)
            : undefined;
          const query = planned ?? retry?.query;
          if (!query || (index > 0 && query === queries[index - 1])) break;

          const cacheKey = {
            tenantId: context?.userId ?? "anonymous",
            indexVersion: options.retrievalPlan?.indexVersion ?? "index-unknown",
            source: "knowledge" as const,
            query,
            filters,
            threshold: ragConfig.similarityThreshold,
            limit: parsed.limit,
            strategyVersion: AGENTIC_RAG_VERSION,
          };
          let response = cache.get(cacheKey);
          const cacheHit = Boolean(response);
          if (!response) {
            const elapsedMs = Date.now() - searchStartedAt;
            const remainingBudgetMs = SEARCH_NOTES_INTERNAL_BUDGET_MS - elapsedMs;
            const canRetry = Boolean(options.retrievalPlan) && index + 1 < maxAttempts;
            const reserveMs = canRetry
              ? SEARCH_NOTES_RETRY_RESERVE_MS
              : SEARCH_NOTES_COMPLETION_RESERVE_MS;
            const timeoutMs = Math.min(
              SEARCH_NOTES_MAX_ATTEMPT_MS,
              remainingBudgetMs - reserveMs,
            );
            if (timeoutMs <= 0) {
              throw new SearchNotesTimeoutError(index + 1, Math.max(0, remainingBudgetMs));
            }
            response = await withSearchAttemptTimeout({
              attempt: index + 1,
              timeoutMs,
              promise: retriever.searchWithDebug(query, {
                matchThreshold: ragConfig.similarityThreshold,
                matchCount: parsed.limit,
                userId: context?.userId,
                conversationContext: context?.conversationContext,
                enableMmr: true,
                enableQueryRewrite: true,
                enableRerank: true,
                filters,
                indexVersion: options.retrievalPlan?.indexVersion,
                timeoutMs,
              }),
            });
          }
          if (!cacheHit) cache.set(cacheKey, response);
          lastResponse = response;
          mergedResults = mergeSearchResults(mergedResults, response.results);
          const evidenceItems = createKnowledgeEvidenceItems(mergedResults);
          finalGrade = gradeKnowledgeEvidence(
            parsed.query,
            mergedResults,
            evidenceItems.map((item) => item.evidenceId),
          );
          attempts.push(buildAttempt({
            attempt: index + 1,
            query,
            response,
            grade: finalGrade,
            cacheHit,
            rewriteReason: index > 0
              ? retry?.reason ?? "planner_secondary_query"
              : undefined,
          }));
          if (finalGrade.sufficient) break;
        }

        if (!lastResponse) {
          throw new Error("检索计划没有生成可执行 query");
        }

        const allEvidenceItems = createKnowledgeEvidenceItems(mergedResults);
        const acceptedEvidence = new Set(finalGrade.acceptedEvidenceIds);
        const evidenceItems = allEvidenceItems.filter((item) =>
          acceptedEvidence.has(item.evidenceId));
        const acceptedChunkIds = new Set(evidenceItems.map((item) => item.chunkId));
        const results = mergedResults.filter((result) => acceptedChunkIds.has(result.id));
        const bundle = createEvidenceBundle({
          plan: options.retrievalPlan,
          route: options.retrievalPlan?.route ?? "knowledge",
          query: parsed.query,
          indexVersion: options.retrievalPlan?.indexVersion ?? "index-unknown",
          evidences: evidenceItems,
          grade: finalGrade,
          attempts,
        });

        if (results.length === 0) {
          return {
            ok: true,
            content: "没有找到足以支持回答的个人知识库证据",
            data: {
              query: parsed.query,
              results: [],
              debug: lastResponse.debug,
              attempts,
              evidenceBundle: bundle,
            },
            metadata: {
              rag: lastResponse.debug,
              ragReturnedCount: 0,
              ragQuery: parsed.query,
              ragTopResults: [],
              ragUsedFallback: false,
              ragThresholdFallback: false,
              ragRetryCount: Math.max(0, attempts.length - 1),
              ragRetryReason: attempts[1]?.grade.reason,
              ragAttempts: attempts,
              retrievalPlanId: options.retrievalPlan?.id,
              evidenceBundle: summarizeEvidenceBundle(bundle),
              evidenceSufficient: false,
            },
          };
        }

        const modelContext = buildModelContext(results, bundle);
        const safeResults = sanitizeResults(results);
        return {
          ok: true,
          content: modelContext.content,
          data: {
            query: parsed.query,
            results: safeResults,
            debug: lastResponse.debug,
            attempts,
            evidenceBundle: bundle,
            context: modelContext,
          },
          metadata: {
            rag: lastResponse.debug,
            ragReturnedCount: results.length,
            ragQuery: parsed.query,
            ragTopResults: buildRagTopResults(results),
            ragUsedFallback: false,
            ragThresholdFallback: false,
            ragRetryCount: Math.max(0, attempts.length - 1),
            ragRetryReason: attempts[1]?.rewriteReason,
            ragAttempts: attempts,
            ragContextTokens: modelContext.tokenCount,
            ragContextSourceCount: modelContext.sourceCount,
            ragContextTruncated: modelContext.contextTruncated,
            ragParentContextsDeduped: modelContext.dedupedParentCount,
            retrievalPlanId: options.retrievalPlan?.id,
            evidenceBundle: summarizeEvidenceBundle(bundle),
            evidenceSufficient: finalGrade.sufficient,
          },
        };
      } catch (error) {
        if (error instanceof RAGRetrievalTimeoutError) {
          return {
            ok: false,
            content: "知识库检索响应超时，请稍后重试",
            error: error.message,
            metadata: {
              status: "retrieval_timeout",
              ragTimedOut: true,
              ragTimeoutPhase: error.phase,
              ragTimeoutMs: error.timeoutMs,
            },
          };
        }
        if (error instanceof SearchNotesTimeoutError) {
          return {
            ok: false,
            content: "知识库检索响应超时，请稍后重试",
            error: error.message,
            metadata: {
              status: "retrieval_timeout",
              ragTimedOut: true,
              ragTimeoutAttempt: error.attempt,
              ragTimeoutMs: error.timeoutMs,
            },
          };
        }
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
