import { describe, expect, it } from "vitest";
import { createConfiguredMemoryReranker, getMemoryRerankConfig } from "./memory-reranker";

describe("memory reranker config", () => {
  it("is disabled until a user configuration is supplied", () => {
    expect(getMemoryRerankConfig()).toMatchObject({ enabled: false, configured: false, mode: "always" });
  });

  it("requires URL and API key in the supplied config", () => {
    expect(createConfiguredMemoryReranker({ ...getMemoryRerankConfig(), enabled: true, configured: false })).toBeUndefined();
  });

  it("does not invent an admission threshold", () => {
    expect(getMemoryRerankConfig().admitThreshold).toBeUndefined();
  });
});
