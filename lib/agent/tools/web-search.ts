import { tavily } from "@tavily/core";
import {
  createEvidenceBundle,
  createWebEvidenceItems,
  summarizeEvidenceBundle,
  type WebEvidenceResult,
} from "@/lib/agent/rag/evidence";
import { gradeEvidenceItems } from "@/lib/agent/rag/evidence-grader";
import { QueryResultCache } from "@/lib/agent/rag/query-cache";
import {
  AGENTIC_RAG_VERSION,
  WEB_RETRIEVAL_INDEX_VERSION,
  type RetrievalAttempt,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

export type WebSearchInput = {
  query: string;
  limit?: number;
  searchDepth?: "basic" | "advanced";
};

export type WebSearchResponse = {
  results?: WebEvidenceResult[];
  [key: string]: unknown;
};

type WebSearchClient = {
  search(query: string, options: Record<string, unknown>): Promise<WebSearchResponse>;
};

const webResultCache = new QueryResultCache<WebSearchResponse>();

function parseInput(input: unknown): WebSearchInput {
  if (!input || typeof input !== "object") {
    return { query: "", limit: 5, searchDepth: "basic" };
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

function webQueries(query: string, plan?: RetrievalPlan) {
  const queries = new Set([query.trim()]);
  for (const step of plan?.steps ?? []) {
    if (step.source === "web" && step.query.trim()) queries.add(step.query.trim());
  }
  return Array.from(queries).filter(Boolean).slice(0, plan?.maxAttempts ?? 2);
}

function webSearchOptions(input: {
  limit?: number;
  searchDepth?: "basic" | "advanced";
  plan?: RetrievalPlan;
}) {
  const timeRange = input.plan?.steps.find((step) => step.source === "web")?.filters?.timeRange;
  return {
    maxResults: Math.min(Math.max(1, input.limit ?? 3), 5),
    searchDepth: input.searchDepth || "basic",
    startDate: timeRange?.from?.slice(0, 10),
    endDate: timeRange?.to?.slice(0, 10),
  };
}

export function createWebSearchTool(options: {
  retrievalPlan?: RetrievalPlan;
  client?: WebSearchClient;
  cache?: QueryResultCache<WebSearchResponse>;
} = {}): ToolDefinition {
  return {
    name: "web_search",
    capabilities: ["public.search", "fresh.information"],
    outputPolicy: {
      grounding: "cited_evidence",
      citationRequired: true,
      retrieval: { source: "web", maxCallsPerRun: 1 },
    },
    orchestration: {
      // 该依赖只在 RetrievalPlan.freshnessRequired=true 时激活。普通网页资料查询
      // 可以直接搜索，不会因为存在 prerequisites 就无条件多调用一次时间工具。
      prerequisites: ["time.current"],
      invokeWhen: "public_freshness_required",
    },
    description:
      "联网搜索公开网页信息。回答公开或实时问题时以搜索结果为准，不要只依赖模型内部知识。调用前先把用户问题改写成一个精确 query：写出核心实体，并按需要补上时间、地区、语言等限定词；不要把整句原话或过于宽泛的词直接当 query。调用受显式 Retrieval Router 和 Query Planner 约束，最多执行两次计划 query；返回结果会形成带 evidenceId 的 EvidenceBundle。个人笔记请使用 search_notes。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词或问题" },
        limit: {
          type: "number",
          description: "返回结果数量，默认 3，最多 5",
          minimum: 1,
          maximum: 5,
        },
        searchDepth: {
          type: "string",
          description: "搜索深度，默认 basic；复杂研究使用 advanced",
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
    execute: async (
      input: unknown,
      context?: ToolExecutionContext,
    ): Promise<ToolResult> => {
      const parsed = parseInput(input);
      if (!parsed.query.trim()) {
        return { ok: false, content: "搜索关键词不能为空" };
      }
      if (!options.client && !process.env.TAVILY_API_KEY) {
        return {
          ok: false,
          content: "缺少环境变量 TAVILY_API_KEY",
          error: "Missing TAVILY_API_KEY",
        };
      }

      try {
        const client = options.client ?? tavily({ apiKey: process.env.TAVILY_API_KEY! });
        const queries = webQueries(parsed.query, options.retrievalPlan);
        const attempts: RetrievalAttempt[] = [];
        const merged = new Map<string, WebEvidenceResult>();
        let finalGrade = gradeEvidenceItems(parsed.query, []);

        for (let index = 0; index < queries.length; index += 1) {
          const query = queries[index];
          const cacheKey = {
            tenantId: context?.userId ?? "anonymous",
            indexVersion: WEB_RETRIEVAL_INDEX_VERSION,
            source: "web" as const,
            query,
            filters: options.retrievalPlan?.steps.find((step) => step.source === "web")?.filters,
            limit: parsed.limit,
            searchDepth: parsed.searchDepth,
            strategyVersion: AGENTIC_RAG_VERSION,
          };
          const cache = options.cache ?? webResultCache;
          let response = cache.get(cacheKey);
          const cacheHit = Boolean(response);
          const startedAt = Date.now();
          response ??= await client.search(query, webSearchOptions({
            limit: parsed.limit,
            searchDepth: parsed.searchDepth,
            plan: options.retrievalPlan,
          }));
          if (!cacheHit) cache.set(cacheKey, response);
          for (const result of response.results ?? []) {
            if (result.url) merged.set(result.url, result);
          }
          const evidenceItems = createWebEvidenceItems(Array.from(merged.values()));
          finalGrade = gradeEvidenceItems(parsed.query, evidenceItems);
          attempts.push({
            attempt: index + 1,
            source: "web",
            query,
            resultCount: evidenceItems.length,
            cacheHit,
            rewriteReason: index > 0 ? "planner_secondary_query" : undefined,
            grade: finalGrade,
            timings: { totalMs: Date.now() - startedAt },
          });
          if (finalGrade.sufficient) break;
        }

        const allEvidence = createWebEvidenceItems(Array.from(merged.values()));
        const accepted = new Set(finalGrade.acceptedEvidenceIds);
        const evidenceItems = allEvidence.filter((item) => accepted.has(item.evidenceId));
        const acceptedUrls = new Set(evidenceItems.flatMap((item) =>
          item.citation.url ? [item.citation.url] : []));
        const acceptedResults = Array.from(merged.values()).filter((result) =>
          typeof result.url === "string" && acceptedUrls.has(result.url));
        const bundle = createEvidenceBundle({
          plan: options.retrievalPlan,
          route: options.retrievalPlan?.route ?? "web",
          query: parsed.query,
          indexVersion: WEB_RETRIEVAL_INDEX_VERSION,
          evidences: evidenceItems,
          grade: finalGrade,
          attempts,
        });
        const content = evidenceItems.length > 0
          ? [
              finalGrade.sufficient
                ? undefined
                : "证据提示：以下公开网页候选通过最低相关性要求，但整体证据充分性不足。",
              ...evidenceItems.map((item, index) =>
                `${index + 1}. [${item.evidenceId}] ${item.title}\n链接：${item.citation.url}\n摘要：${item.content}`),
            ].filter(Boolean).join("\n\n")
          : "没有找到足以支持回答的公开网页证据";

        return {
          ok: true,
          content,
          data: {
            response: { results: acceptedResults },
            evidenceBundle: bundle,
          },
          metadata: {
            retrievalPlanId: options.retrievalPlan?.id,
            evidenceBundle: summarizeEvidenceBundle(bundle),
            retrievalAttempts: attempts,
            evidenceSufficient: finalGrade.sufficient,
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
}

export const webSearchTool: ToolDefinition = createWebSearchTool();
