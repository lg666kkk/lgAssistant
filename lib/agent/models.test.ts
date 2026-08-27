import { describe, expect, it } from "vitest";
import { resolveChatModel, supportsImageInput } from "./models";
import { rememberModelMetadata } from "@/lib/llm/model-metadata-cache";

describe("chat model capabilities", () => {
  it("exposes the DeepSeek vision model without changing the default fallback", () => {
    expect(resolveChatModel("deepseek-v4-flash-vision-exp"))
      .toBe("deepseek-v4-flash-vision-exp");
    expect(supportsImageInput("deepseek-v4-flash-vision-exp")).toBe(true);
    expect(supportsImageInput("deepseek-v4-pro")).toBe(false);
    expect(resolveChatModel("unknown-model")).toBe("deepseek-v4-pro");
  });

  it("uses dynamic user model capabilities", () => {
    rememberModelMetadata("model-config-1", {
      contextWindow: 64_000,
      supportsImages: true,
    });
    expect(supportsImageInput("model-config-1")).toBe(true);
  });
});
