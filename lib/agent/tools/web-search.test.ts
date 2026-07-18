import { describe, expect, it, vi } from "vitest";
import { QueryResultCache } from "@/lib/agent/rag/query-cache";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import {
  createWebSearchTool,
  type WebSearchResponse,
} from "./web-search";

function plan(queries: string[], indexVersion = "web-2026-07-17"): RetrievalPlan {
  return {
    id: "retrieval-web-test",
    version: AGENTIC_RAG_VERSION,
    route: "web",
    originalQuery: queries[0],
    standaloneQuery: queries[0],
    queryType: "semantic",
    reason: "fresh_or_public_information_required",
    confidence: 1,
    evidenceRequired: true,
    maxAttempts: 2,
    indexVersion,
    steps: queries.map((query, index) => ({
      id: `web-${index + 1}`,
      source: "web",
      query,
      purpose: index === 0 ? "primary_retrieval" : "multi_hop_or_rewrite",
    })),
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

describe("web_search evidence loop", () => {
  it("runs the second planned query when the first has no evidence", async () => {
    const client = {
      search: vi.fn()
        .mockResolvedValueOnce({ results: [] })
        .mockResolvedValueOnce({
          results: [{
            title: "Agentic RAG architecture",
            url: "https://docs.example.com/agentic-rag",
            content: "Agentic RAG uses an explicit retrieval router and evidence grading loop.",
            score: 0.9,
          }],
        }),
    };
    const tool = createWebSearchTool({
      retrievalPlan: plan(["Agentic RAG 最新架构", "Agentic RAG retrieval router evidence grader"]),
      client,
      cache: new QueryResultCache(),
    });

    const result = await tool.execute(
      { query: "Agentic RAG 最新架构" },
      { userId: "user-1" },
    );
    const bundle = (result.data as { evidenceBundle: EvidenceBundle }).evidenceBundle;

    expect(client.search).toHaveBeenCalledTimes(2);
    expect(bundle.evidences).toHaveLength(1);
    expect(bundle.attempts).toHaveLength(2);
    expect(result.content).toContain(`[${bundle.evidences[0].evidenceId}]`);
  });

  it("does not expose candidates when the evidence grade is insufficient", async () => {
    const client = {
      search: vi.fn().mockResolvedValue({
        results: [{
          title: "Unrelated page",
          url: "https://example.com/unrelated",
          content: "A page about cooking recipes.",
          score: 0.4,
        }],
      }),
    };
    const tool = createWebSearchTool({
      retrievalPlan: plan(["RAG 路由准确率"]),
      client,
      cache: new QueryResultCache(),
    });

    const result = await tool.execute(
      { query: "RAG 路由准确率" },
      { userId: "user-1" },
    );
    const bundle = (result.data as { evidenceBundle: EvidenceBundle }).evidenceBundle;

    expect(bundle.grade.sufficient).toBe(false);
    expect(bundle.evidences).toEqual([]);
    expect(result.content).toBe("没有找到足以支持回答的公开网页证据");
  });

  it("reuses cached results only for the same tenant and index version", async () => {
    const client = {
      search: vi.fn().mockResolvedValue({ results: [] }),
    };
    const cache = new QueryResultCache<WebSearchResponse>();
    const tool = createWebSearchTool({
      retrievalPlan: plan(["最新 RAG 新闻"]),
      client,
      cache,
    });

    await tool.execute({ query: "最新 RAG 新闻" }, { userId: "user-1" });
    const second = await tool.execute({ query: "最新 RAG 新闻" }, { userId: "user-1" });

    expect(client.search).toHaveBeenCalledTimes(1);
    expect(second.metadata?.retrievalAttempts).toMatchObject([{ cacheHit: true }]);
  });

  it("does not reuse a basic cache entry for an advanced search", async () => {
    const client = {
      search: vi.fn().mockResolvedValue({ results: [] }),
    };
    const cache = new QueryResultCache<WebSearchResponse>();
    const tool = createWebSearchTool({
      retrievalPlan: plan(["Agentic RAG research"]),
      client,
      cache,
    });

    await tool.execute({ query: "Agentic RAG research", searchDepth: "basic" }, { userId: "user-1" });
    await tool.execute({ query: "Agentic RAG research", searchDepth: "advanced" }, { userId: "user-1" });

    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search.mock.calls[1][1]).toMatchObject({ searchDepth: "advanced" });
  });

  it("keeps web cache entries independent from knowledge index versions", async () => {
    const client = {
      search: vi.fn().mockResolvedValue({ results: [] }),
    };
    const cache = new QueryResultCache<WebSearchResponse>();
    const first = createWebSearchTool({
      retrievalPlan: plan(["latest RAG news"], "knowledge-v1"),
      client,
      cache,
    });
    const second = createWebSearchTool({
      retrievalPlan: plan(["latest RAG news"], "knowledge-v2"),
      client,
      cache,
    });

    await first.execute({ query: "latest RAG news" }, { userId: "user-1" });
    await second.execute({ query: "latest RAG news" }, { userId: "user-1" });

    expect(client.search).toHaveBeenCalledTimes(1);
  });
});
