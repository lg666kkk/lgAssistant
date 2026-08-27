import { describe, expect, it } from "vitest";
import { assertPublicProviderUrl, normalizeProviderBaseUrl } from "./url-safety";

describe("LLM provider URL safety", () => {
  it("normalizes an HTTPS OpenAI-compatible base URL", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com/v1/"))
      .toBe("https://api.example.com/v1");
  });

  it.each([
    "file:///tmp/provider",
    "http://localhost:11434/v1",
    "http://service.local/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?token=secret",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => normalizeProviderBaseUrl(value)).toThrow();
  });

  it.each([
    "http://127.0.0.1:11434/v1",
    "http://10.0.0.2/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/v1",
  ])("rejects private or metadata address %s", async (value) => {
    await expect(assertPublicProviderUrl(value)).rejects.toThrow();
  });
});

