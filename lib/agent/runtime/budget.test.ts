import { describe, expect, it } from "vitest";
import { estimateTokens } from "./budget";

describe("agent runtime token estimation", () => {
  it("counts inline images by vision tokens instead of tokenizing base64", () => {
    const tokens = estimateTokens({
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "a".repeat(200_000) },
      }],
    });

    expect(tokens).toBeGreaterThanOrEqual(384);
    expect(tokens).toBeLessThan(500);
  });
});
