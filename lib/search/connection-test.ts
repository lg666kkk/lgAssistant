import { createSearchProviderClient } from "./providers";
import type { ResolvedSearchProvider } from "./types";

export async function testSearchProviderConnection(provider: ResolvedSearchProvider) {
  const startedAt = Date.now();
  const response = await createSearchProviderClient(provider.id, provider.apiKey).search(
    "OpenAI official website",
    { maxResults: 1, searchDepth: "basic" },
  );
  return {
    ok: true as const,
    provider: provider.id,
    latencyMs: Date.now() - startedAt,
    resultCount: response.results.length,
  };
}
