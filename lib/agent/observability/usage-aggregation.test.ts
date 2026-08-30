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

  it("prices a user model with the current catalog when an old trace has no snapshot", () => {
    const result = aggregateUsageTraces([{
      id: "trace-old",
      request_id: "request-old",
      session_id: "session-1",
      created_at: "2026-08-29T00:00:00.000Z",
      steps: [{
        type: "model",
        model: "model-uuid",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cacheHitTokens: 20,
          cacheMissTokens: 80,
          estimatedCostCny: 0,
        },
      }],
    }], {
      chatModels: [{
        id: "model-uuid",
        name: "DeepSeek Chat",
        providerName: "My Provider",
        pricing: { inputCacheHit: 1, inputCacheMiss: 3, output: 5 },
      }],
    });

    expect(result.models[0]).toMatchObject({
      modelName: "DeepSeek Chat",
      providerName: "My Provider",
      pricingSource: "current",
      pricingConfigured: true,
      unpricedTokens: 0,
    });
    expect(result.models[0].estimatedCostCny).toBeCloseTo(0.00031, 10);
  });

  it("uses the trace pricing snapshot before the current catalog price", () => {
    const result = aggregateUsageTraces([{
      id: "trace-new",
      request_id: "request-new",
      created_at: "2026-08-29T00:00:00.000Z",
      steps: [{
        type: "model",
        model: "model-uuid",
        modelName: "Snapshot Name",
        providerName: "Snapshot Provider",
        pricingSnapshot: { inputCacheHit: 2, inputCacheMiss: 4, output: 6 },
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cacheHitTokens: 20,
          cacheMissTokens: 80,
        },
      }],
    }], {
      chatModels: [{
        id: "model-uuid",
        name: "Current Name",
        pricing: { inputCacheHit: 1, inputCacheMiss: 1, output: 1 },
      }],
    });

    expect(result.models[0]).toMatchObject({
      modelName: "Snapshot Name",
      providerName: "Snapshot Provider",
      pricingSource: "trace",
    });
    expect(result.models[0].estimatedCostCny).toBeCloseTo(0.00042, 10);
  });

  it("marks tokens as unpriced when a user model has no price", () => {
    const result = aggregateUsageTraces([{
      id: "trace-unpriced",
      request_id: "request-unpriced",
      created_at: "2026-08-29T00:00:00.000Z",
      steps: [{
        type: "model",
        model: "model-uuid",
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      }],
    }], {
      chatModels: [{ id: "model-uuid", name: "Unknown Price Model" }],
    });

    expect(result.models[0]).toMatchObject({
      pricingSource: "unknown",
      pricingConfigured: false,
      unpricedTokens: 55,
      estimatedCostCny: 0,
    });
    expect(result.total.unpricedTokens).toBe(55);
  });

  it("uses user prices for embedding and rerank instead of static defaults", () => {
    const result = aggregateUsageTraces([{
      id: "trace-metered",
      request_id: "request-metered",
      created_at: "2026-08-29T00:00:00.000Z",
      steps: [{
        type: "memory_recall",
        embeddingUsage: {
          model: "text-embedding-v4",
          inputTokens: 100,
          totalTokens: 100,
          modelCallCount: 1,
        },
        rerank: {
          model: "qwen3-rerank",
          providerModel: "qwen3-rerank",
          totalTokens: 200,
        },
      }],
    }], {
      meteredModels: [
        {
          id: "text-embedding-v4",
          name: "My Embedding",
          category: "embedding",
          inputPriceCnyPerMillionTokens: 2,
          source: "database",
        },
        {
          id: "qwen3-rerank",
          name: "My Rerank",
          category: "rerank",
          inputPriceCnyPerMillionTokens: 3,
          source: "database",
        },
      ],
    });

    expect(result.models.find((model) => model.category === "embedding")).toMatchObject({
      modelName: "My Embedding",
      inputPriceCnyPerMillionTokens: 2,
      pricingSource: "current",
      estimatedCostCny: 0.0002,
    });
    const rerank = result.models.find((model) => model.category === "rerank");
    expect(rerank).toMatchObject({
      modelName: "My Rerank",
      inputPriceCnyPerMillionTokens: 3,
      pricingSource: "current",
    });
    expect(rerank?.estimatedCostCny).toBeCloseTo(0.0006, 10);
  });

  it("merges legacy model strings and current configuration UUIDs by provider model id", () => {
    const result = aggregateUsageTraces([
      {
        id: "legacy-trace",
        request_id: "legacy-request",
        created_at: "2026-08-28T00:00:00.000Z",
        steps: [{
          type: "model",
          model: "deepseek-v4-pro",
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        }],
      },
      {
        id: "current-trace",
        request_id: "current-request",
        created_at: "2026-08-29T00:00:00.000Z",
        steps: [{
          type: "model",
          model: "model-uuid",
          usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
        }],
      },
    ], {
      chatModels: [{
        id: "model-uuid",
        providerModelId: "deepseek-v4-pro",
        name: "deepseek-v4-pro",
        providerName: "DeepSeek",
      }],
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      model: "deepseek-v4-pro",
      modelName: "DeepSeek V4 Pro",
      providerName: "DeepSeek",
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      modelCallCount: 2,
      requestCount: 2,
    });
  });
});
