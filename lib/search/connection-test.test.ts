import { afterEach, describe, expect, it, vi } from "vitest";
import { testSearchProviderConnection } from "./connection-test";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("testSearchProviderConnection", () => {
  it("returns latency and result count after a successful request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      web: {
        results: [{
          title: "OpenAI",
          url: "https://openai.com/",
          description: "Official site",
        }],
      },
    }), { status: 200 })));

    const result = await testSearchProviderConnection({ id: "brave", apiKey: "test-key" });

    expect(result).toMatchObject({
      ok: true,
      provider: "brave",
      resultCount: 1,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
