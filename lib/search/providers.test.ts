import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchProviderClient } from "./providers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search provider adapters", () => {
  it("normalizes Exa results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{
        title: "Agent research",
        url: "https://example.com/research",
        score: 0.91,
        highlights: ["Semantic search result"],
      }],
    }), { status: 200 })));

    const response = await createSearchProviderClient("exa", "exa-key")
      .search("agent research", { maxResults: 3, searchDepth: "advanced" });

    expect(response.provider).toBe("exa");
    expect(response.results).toEqual([expect.objectContaining({
      title: "Agent research",
      content: "Semantic search result",
      score: 0.91,
    })]);
    expect(fetch).toHaveBeenCalledWith("https://api.exa.ai/search", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-api-key": "exa-key" }),
    }));
  });

  it("normalizes Brave web results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      web: {
        results: [{
          title: "Fresh result",
          url: "https://example.com/fresh",
          description: "Primary snippet",
          extra_snippets: ["Extra snippet"],
        }],
      },
    }), { status: 200 })));

    const response = await createSearchProviderClient("brave", "brave-key")
      .search("fresh news", { maxResults: 5 });

    expect(response.provider).toBe("brave");
    expect(response.results[0]).toMatchObject({
      title: "Fresh result",
      content: "Primary snippet\nExtra snippet",
    });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("api.search.brave.com/res/v1/web/search");
    expect(options?.headers).toMatchObject({ "X-Subscription-Token": "brave-key" });
  });
});
