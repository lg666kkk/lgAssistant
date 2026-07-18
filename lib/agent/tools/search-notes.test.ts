import { describe, expect, it, vi } from "vitest";
import type {
  RAGSearchOptions,
  RAGSearchResponse,
  SearchResult,
} from "@/lib/knowledge/retriever";
import { QueryResultCache } from "@/lib/agent/rag/query-cache";
import {
  AGENTIC_RAG_VERSION,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import { createSearchNotesTool } from "./search-notes";

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chunk-1",
    pageId: "page-1",
    pageTitle: "RAG 设计",
    pageUrl: "https://example.com/rag",
    content: "RAG 使用检索结果增强回答。",
    similarity: 0.6,
    vectorScore: 0.6,
    keywordScore: 0,
    combinedScore: 0.42,
    rerankScore: 0.42,
    retrievalSources: ["vector"],
    headingPath: ["RAG"],
    ...overrides,
  };
}

function response(
  results: SearchResult[],
  matchThreshold: number,
): RAGSearchResponse {
  return {
    results,
    debug: {
      originalQuery: "RAG 是什么",
      standaloneQuery: "RAG 是什么",
      queryType: "exact",
      rewrittenQueries: ["RAG 是什么"],
      vectorQueryCount: 1,
      multiQueryVectorEnabled: true,
      requestedMatchCount: 5,
      effectiveMatchCount: 5,
      candidateLimit: 20,
      candidateCount: results.length,
      filteredCandidateCount: results.length,
      vectorCandidateCount: results.length,
      keywordCandidateCount: 0,
      mergedCandidateCount: results.length,
      returnedCount: results.length,
      matchThreshold,
      fusionStrategy: "rrf",
      rrfK: 60,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
      keywordSearchEnabled: true,
      mmrEnabled: true,
      mmrSimilarityMode: "text",
      rerankEnabled: true,
      crossEncoderEnabled: false,
      crossEncoderUsed: false,
      crossEncoderReason: "disabled",
      topScoreGap: null,
      timings: {
        embeddingMs: 0,
        vectorSearchMs: 0,
        keywordSearchMs: 0,
        parallelRecallMs: 0,
        fusionMs: 0,
        ruleRerankMs: 0,
        crossEncoderMs: 0,
        mmrMs: 0,
        embeddingCacheHits: 0,
        embeddingCacheMisses: 1,
        totalMs: 0,
      },
    },
  };
}

function retrievalPlan(queries: string[]): RetrievalPlan {
  return {
    id: "retrieval-test",
    version: AGENTIC_RAG_VERSION,
    route: "knowledge",
    originalQuery: queries[0],
    standaloneQuery: queries[0],
    queryType: "semantic",
    reason: "test",
    confidence: 1,
    evidenceRequired: true,
    maxAttempts: 2,
    indexVersion: "index-test",
    steps: queries.map((query, index) => ({
      id: `knowledge-${index + 1}`,
      source: "knowledge",
      query,
      purpose: index === 0 ? "primary_retrieval" : "multi_hop_or_rewrite",
    })),
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

function createTestTool(
  searchWithDebug: (
    query: string,
    options?: RAGSearchOptions,
  ) => Promise<RAGSearchResponse>,
  plan?: RetrievalPlan,
) {
  return createSearchNotesTool({
    retriever: { searchWithDebug },
    retrievalPlan: plan,
    cache: new QueryResultCache<RAGSearchResponse>(),
  });
}

describe("search_notes bounded evidence loop", () => {
  it("does not retry when primary retrieval returns evidence", async () => {
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([searchResult()], 0.5),
    );
    const tool = createTestTool(searchWithDebug);

    expect(tool.runtime.timeoutSeconds).toBe(45);

    const result = await tool.execute(
      { query: "RAG 是什么" },
      {
        userId: "user-1",
        conversationContext: ["上一轮讨论了检索增强生成"],
      },
    );

    expect(result.ok).toBe(true);
    expect(searchWithDebug).toHaveBeenCalledTimes(1);
    expect(searchWithDebug.mock.calls[0][1]).toMatchObject({
      conversationContext: ["上一轮讨论了检索增强生成"],
    });
    expect(result.metadata).toMatchObject({
      ragReturnedCount: 1,
      ragUsedFallback: false,
    });
  });

  it("retries a planned query without lowering the threshold", async () => {
    const fallbackResult = searchResult({
      similarity: 0.45,
      vectorScore: 0.45,
      combinedScore: 0.315,
      rerankScore: 0.315,
    });
    const searchWithDebug = vi
      .fn()
      .mockResolvedValueOnce(response([], 0.5))
      .mockResolvedValueOnce(response([fallbackResult], 0.5));
    const tool = createTestTool(
      searchWithDebug,
      retrievalPlan(["RAG 是什么", "检索增强生成 原理"]),
    );

    const result = await tool.execute(
      { query: "RAG 是什么", limit: 10 },
      { userId: "user-1" },
    );

    expect(searchWithDebug).toHaveBeenCalledTimes(2);
    expect(searchWithDebug.mock.calls[0][1]).toMatchObject({
      matchCount: 5,
    });
    expect(searchWithDebug.mock.calls[1][1]).toMatchObject({
      matchThreshold: 0.5,
      matchCount: 5,
    });
    expect(searchWithDebug.mock.calls[1][1].matchThreshold).toBeGreaterThan(0);
    expect(result.metadata).toMatchObject({
      ragReturnedCount: 1,
      ragThresholdFallback: false,
      ragRetryCount: 1,
      ragRetryReason: "planner_secondary_query",
    });
  });

  it("deduplicates parent contexts and removes internal vectors from structured output", async () => {
    const parentContent = "父段落包含完整上下文。";
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([
        searchResult({
          id: "chunk-1",
          parentKey: "page-1:0:100",
          parentContent,
          embedding: [1, 0],
          metadata: { parent_content: parentContent, parent_key: "page-1:0:100" },
        }),
        searchResult({
          id: "chunk-2",
          content: "同一父段落里的另一个 child。",
          parentKey: "page-1:0:100",
          parentContent,
          embedding: [0, 1],
        }),
      ], 0.5),
    );
    const tool = createTestTool(searchWithDebug);

    const result = await tool.execute(
      { query: "RAG 是什么", limit: 100 },
      { userId: "user-1" },
    );
    const data = result.data as {
      results: Array<Record<string, unknown>>;
      context: { sourceCount: number; dedupedParentCount: number };
    };

    expect(searchWithDebug.mock.calls[0][1]).toMatchObject({ matchCount: 5 });
    expect(data.context).toMatchObject({ sourceCount: 1, dedupedParentCount: 1 });
    expect(data.results[0]).not.toHaveProperty("embedding");
    expect(data.results[0]).not.toHaveProperty("parentContent");
    expect(data.results[0].metadata).not.toHaveProperty("parent_content");
    expect(result.metadata).toMatchObject({
      ragContextSourceCount: 1,
      ragParentContextsDeduped: 1,
    });
  });

  it("enforces the final model context token budget", async () => {
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([
        searchResult({
          parentKey: "page-1:0:99999",
          parentContent: "检索证据 ".repeat(6_000),
        }),
      ], 0.5),
    );
    const tool = createTestTool(searchWithDebug);

    const result = await tool.execute(
      { query: "RAG 是什么" },
      { userId: "user-1" },
    );

    expect(result.metadata?.ragContextTokens).toBeLessThanOrEqual(2_400);
    expect(result.metadata?.ragContextTruncated).toBe(true);
  });

  it("returns no result when fallback candidates fail the evidence gate", async () => {
    const weakResult = searchResult({
      similarity: 0.41,
      vectorScore: 0.41,
      combinedScore: 0.2,
      rerankScore: 0.2,
    });
    const searchWithDebug = vi
      .fn()
      .mockResolvedValueOnce(response([], 0.5))
      .mockResolvedValueOnce(response([weakResult], 0.5));
    const tool = createTestTool(
      searchWithDebug,
      retrievalPlan(["不存在的资料", "不存在资料 精确记录"]),
    );

    const result = await tool.execute(
      { query: "不存在的资料" },
      { userId: "user-1" },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("没有找到足以支持回答的个人知识库证据");
    expect(result.metadata).toMatchObject({
      ragReturnedCount: 0,
      ragThresholdFallback: false,
      ragRetryCount: 1,
      ragAttempts: [
        { attempt: 1, acceptedCount: 0, threshold: 0.5 },
        {
          attempt: 2,
          returnedCount: 1,
          acceptedCount: 0,
          rejectedCount: 1,
          threshold: 0.5,
        },
      ],
    });
  });

  it("returns individually accepted evidence even when overall sufficiency is weak", async () => {
    const weakButAccepted = searchResult({
      content: "alpha",
      similarity: 0.52,
      vectorScore: 0.52,
      combinedScore: 0.52,
      rerankScore: 0.52,
    });
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([weakButAccepted], 0.5),
    );
    const tool = createTestTool(searchWithDebug);

    const result = await tool.execute(
      { query: "alpha beta gamma delta epsilon" },
      { userId: "user-1" },
    );

    expect(result.metadata).toMatchObject({
      ragReturnedCount: 1,
      evidenceSufficient: false,
    });
    expect(result.content).toContain("整体证据充分性不足");
    expect((result.data as { results: unknown[] }).results).toHaveLength(1);
  });

  it("keeps planner filters authoritative while accepting extra tool filters", async () => {
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([searchResult()], 0.5),
    );
    const plan = retrievalPlan(["RAG 是什么"]);
    plan.steps[0].filters = { titleContains: "Planner 标题" };
    const tool = createTestTool(searchWithDebug, plan);

    await tool.execute({
      query: "RAG 是什么",
      filters: {
        titleContains: "模型覆盖标题",
        sourceTypes: ["document"],
      },
    }, { userId: "user-1" });

    expect(searchWithDebug.mock.calls[0][1]?.filters).toEqual({
      titleContains: "Planner 标题",
      sourceTypes: ["document"],
    });
  });

  it("returns a retrieval timeout before the outer tool timeout can hide the cause", async () => {
    vi.useFakeTimers();
    try {
      const searchWithDebug = vi.fn(() => new Promise<RAGSearchResponse>(() => {}));
      const tool = createTestTool(searchWithDebug);

      const resultPromise = tool.execute({ query: "RAG 是什么" }, { userId: "user-1" });
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await resultPromise;

      expect(result).toMatchObject({
        ok: false,
        content: "知识库检索响应超时，请稍后重试",
        error: "知识库第 1 次检索在 25 秒内未完成",
        metadata: {
          status: "retrieval_timeout",
          ragTimedOut: true,
          ragTimeoutAttempt: 1,
          ragTimeoutMs: 25_000,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
