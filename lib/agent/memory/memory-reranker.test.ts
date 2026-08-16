import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemoryRerankConfig } from "./memory-reranker";

describe("memory reranker config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires a complete rerank URL and API key", () => {
    vi.stubEnv("MEMORY_RERANK_ENABLED", "true");
    vi.stubEnv("MEMORY_RERANK_URL", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks");
    vi.stubEnv("MEMORY_RERANK_API_KEY", "test-key");

    expect(getMemoryRerankConfig()).toMatchObject({
      enabled: true,
      configured: true,
      mode: "always",
    });
  });

  it("stays unconfigured without the full URL", () => {
    vi.stubEnv("MEMORY_RERANK_URL", "");
    vi.stubEnv("MEMORY_RERANK_API_KEY", "test-key");

    expect(getMemoryRerankConfig().configured).toBe(false);
  });

  it("does not invent an admission threshold", () => {
    vi.stubEnv("MEMORY_RERANK_ADMIT_THRESHOLD", "");
    expect(getMemoryRerankConfig().admitThreshold).toBeUndefined();

    vi.stubEnv("MEMORY_RERANK_ADMIT_THRESHOLD", "0.63");
    expect(getMemoryRerankConfig().admitThreshold).toBe(0.63);
  });
});
