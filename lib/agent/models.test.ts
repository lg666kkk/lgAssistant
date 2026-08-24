import { describe, expect, it } from "vitest";
import { resolveChatModel, supportsImageInput } from "./models";

describe("chat model capabilities", () => {
  it("exposes the DeepSeek vision model without changing the default fallback", () => {
    expect(resolveChatModel("deepseek-v4-flash-vision-exp"))
      .toBe("deepseek-v4-flash-vision-exp");
    expect(supportsImageInput("deepseek-v4-flash-vision-exp")).toBe(true);
    expect(supportsImageInput("deepseek-v4-pro")).toBe(false);
    expect(resolveChatModel("unknown-model")).toBe("deepseek-v4-pro");
  });
});
