import { describe, expect, it } from "vitest";
import { aggregateUsageTraces } from "./usage-aggregation";

describe("aggregateUsageTraces", () => {
  it("aggregates chat, embedding, rerank, and cache savings without double counting", () => {
    const result = aggregateUsageTraces([
      {
        id: "trace-1",
        request_id: "request-1",
        session_id: "session-1",
        created_at: "2026-08-16T00:00:00.000Z",
        total_duration_ms: 100,
        sessions: { title: "usage test" },
        steps: [
          {
            type: "model",
            model: "deepseek-v4-pro",
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              totalTokens: 110,
              cacheHitTokens: 20,
              cacheMissTokens: 80,
              cacheCreationTokens: 0,
            },
          },
          {
            type: "memory_recall",
            embeddingUsage: {
              model: "text-embedding-v4",
              inputTokens: 40,
              totalTokens: 40,
              modelCallCount: 1,
            },
            rerank: {
              model: "qwen3-rerank",
              providerModel: "qwen3-rerank",
              totalTokens: 60,
            },
          },
          {
            type: "retrieval",
            attempts: [
              {
                cacheHit: false,
                debug: {
                  embeddingUsage: {
                    model: "text-embedding-v4",
                    inputTokens: 30,
                    totalTokens: 30,
                    modelCallCount: 1,
                    cacheHitTokens: 10,
                    cacheMissTokens: 30,
                    cacheHitCalls: 1,
                  },
                },
              },
              {
                cacheHit: true,
                debug: {
                  embeddingUsage: {
                    model: "text-embedding-v4",
                    inputTokens: 30,
                    totalTokens: 30,
                    modelCallCount: 1,
                    cacheHitTokens: 10,
                    cacheMissTokens: 30,
                    cacheHitCalls: 1,
                  },
                },
              },
            ],
          },
        ],
      },
    ]);

    const embedding = result.models.find((model) => model.model === "text-embedding-v4");
    const rerank = result.models.find((model) => model.model === "qwen3-rerank");
    const chat = result.models.find((model) => model.model === "deepseek-v4-pro");

    expect(embedding).toMatchObject({
      category: "embedding",
      inputTokens: 70,
      totalTokens: 70,
      cacheHitTokens: 50,
      cacheMissTokens: 70,
      modelCallCount: 2,
      cacheHitCalls: 3,
      cacheSavedCostCny: 0.000025,
    });
    expect(embedding?.estimatedCostCny).toBeCloseTo(0.000035, 10);
    expect(rerank).toMatchObject({
      category: "rerank",
      inputTokens: 60,
      modelCallCount: 1,
      estimatedCostCny: 0.00003,
      cacheSavedCostCny: 0,
    });
    expect(chat?.cacheSavedCostCny).toBeCloseTo(0.0000595, 10);
    expect(result.total.requestCount).toBe(1);
    expect(result.requests).toHaveLength(1);
  });
});
