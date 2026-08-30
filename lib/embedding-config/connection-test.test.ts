import { describe, expect, it, vi } from "vitest";
import { testEmbeddingConnection } from "./connection-test";

describe("testEmbeddingConnection", () => {
  it("returns the verified vector identity, latency and provider usage", async () => {
    const embedSingle = vi.fn(async (_text: string, options: any) => {
      options.onEvent({ type: "batch_done", inputTokens: 5, totalTokens: 6 });
      return Array.from({ length: 1024 }, () => 0.1);
    });
    const timestamps = [1_000, 1_125];

    const result = await testEmbeddingConnection({
      userId: "user-1",
      provider: "dashscope",
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      modelId: "text-embedding-v4",
      dimensions: 1024,
      inputPriceCnyPerMillionTokens: 0.5,
    }, {
      client: { embedSingle },
      now: () => timestamps.shift() ?? 1_125,
    });

    expect(result).toEqual({
      ok: true,
      provider: "dashscope",
      modelId: "text-embedding-v4",
      dimensions: 1024,
      latencyMs: 125,
      inputTokens: 5,
      totalTokens: 6,
    });
    expect(embedSingle).toHaveBeenCalledWith(
      "向量嵌入连接测试",
      expect.objectContaining({ idempotencyScope: "connection-test:user-1" }),
    );
  });
});
