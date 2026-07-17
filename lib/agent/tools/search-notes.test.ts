import { describe, expect, it, vi } from "vitest";
import type {
  RAGSearchResponse,
  SearchResult,
} from "@/lib/knowledge/retriever";
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
        crossEncoderMs: 0,
        totalMs: 0,
      },
    },
  };
}

describe("search_notes bounded fallback", () => {
  it("does not retry when primary retrieval returns evidence", async () => {
    const searchWithDebug = vi.fn().mockResolvedValue(
      response([searchResult()], 0.5),
    );
    const tool = createSearchNotesTool({ retriever: { searchWithDebug } });

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

  it("uses a bounded non-zero threshold and limits fallback results", async () => {
    const fallbackResult = searchResult({
      similarity: 0.45,
      vectorScore: 0.45,
      combinedScore: 0.315,
      rerankScore: 0.315,
    });
    const searchWithDebug = vi
      .fn()
      .mockResolvedValueOnce(response([], 0.5))
      .mockResolvedValueOnce(response([fallbackResult], 0.4));
    const tool = createSearchNotesTool({ retriever: { searchWithDebug } });

    const result = await tool.execute(
      { query: "RAG 是什么", limit: 10 },
      { userId: "user-1" },
    );

    expect(searchWithDebug).toHaveBeenCalledTimes(2);
    expect(searchWithDebug.mock.calls[0][1]).toMatchObject({
      matchCount: 5,
    });
    expect(searchWithDebug.mock.calls[1][1]).toMatchObject({
      matchThreshold: 0.4,
      matchCount: 3,
    });
    expect(searchWithDebug.mock.calls[1][1].matchThreshold).toBeGreaterThan(0);
    expect(result.metadata).toMatchObject({
      ragReturnedCount: 1,
      ragUsedFallback: true,
      ragFallbackReason: "primary_no_results",
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
    const tool = createSearchNotesTool({ retriever: { searchWithDebug } });

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
    const tool = createSearchNotesTool({ retriever: { searchWithDebug } });

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
      .mockResolvedValueOnce(response([weakResult], 0.4));
    const tool = createSearchNotesTool({ retriever: { searchWithDebug } });

    const result = await tool.execute(
      { query: "不存在的资料" },
      { userId: "user-1" },
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("没有找到相关笔记");
    expect(result.metadata).toMatchObject({
      ragReturnedCount: 0,
      ragUsedFallback: true,
      ragAttempts: [
        { label: "primary", acceptedCount: 0 },
        {
          label: "bounded_fallback",
          returnedCount: 1,
          acceptedCount: 0,
          rejectedCount: 1,
        },
      ],
    });
  });
});
