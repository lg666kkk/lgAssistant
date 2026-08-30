import { EmbeddingClient } from "@/lib/knowledge/embedding";
import type { ResolvedUserEmbeddingConfig } from "./types";

export async function testEmbeddingConnection(
  config: ResolvedUserEmbeddingConfig,
  dependencies: {
    client?: Pick<EmbeddingClient, "embedSingle">;
    now?: () => number;
  } = {},
) {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const client = dependencies.client ?? new EmbeddingClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.modelId,
    dimensions: config.dimensions,
  });
  let inputTokens = 0;
  let totalTokens = 0;
  const vector = await client.embedSingle("向量嵌入连接测试", {
    idempotencyScope: `connection-test:${config.userId}`,
    onEvent: (event) => {
      if (event.type !== "batch_done") return;
      inputTokens += event.inputTokens ?? 0;
      totalTokens += event.totalTokens ?? event.inputTokens ?? 0;
    },
  });
  return {
    ok: true as const,
    provider: config.provider,
    modelId: config.modelId,
    dimensions: vector.length,
    latencyMs: now() - startedAt,
    inputTokens,
    totalTokens,
  };
}
