import { tavily } from "@tavily/core";
import type { WebEvidenceResult } from "@/lib/agent/rag/evidence";
import type { SearchProviderId } from "./types";

export type SearchRequestOptions = {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  startDate?: string;
  endDate?: string;
};

export type SearchProviderResponse = {
  results: WebEvidenceResult[];
  provider: SearchProviderId;
};

export type SearchProviderClient = {
  id: SearchProviderId;
  search(query: string, options: SearchRequestOptions): Promise<SearchProviderResponse>;
};

function providerError(provider: string, response: Response, payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const detail = typeof record?.message === "string"
    ? record.message
    : typeof record?.error === "string"
      ? record.error
      : undefined;
  return new Error(detail
    ? `${provider} 返回 ${response.status}: ${detail.slice(0, 300)}`
    : `${provider} 返回 HTTP ${response.status}`);
}

function createTavilyClient(apiKey: string): SearchProviderClient {
  const client = tavily({ apiKey });
  return {
    id: "tavily",
    async search(query, options) {
      const response = await client.search(query, {
        maxResults: options.maxResults,
        searchDepth: options.searchDepth,
        startDate: options.startDate,
        endDate: options.endDate,
      });
      return { provider: "tavily", results: response.results ?? [] };
    },
  };
}

function createExaClient(apiKey: string): SearchProviderClient {
  return {
    id: "exa",
    async search(query, options) {
      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          type: "auto",
          numResults: options.maxResults ?? 5,
          startPublishedDate: options.startDate ? `${options.startDate}T00:00:00.000Z` : undefined,
          endPublishedDate: options.endDate ? `${options.endDate}T23:59:59.999Z` : undefined,
          contents: {
            highlights: { numSentences: options.searchDepth === "advanced" ? 5 : 3, highlightsPerUrl: 1 },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null) as {
        results?: Array<{
          title?: string;
          url?: string;
          score?: number;
          text?: string;
          summary?: string;
          highlights?: string[];
        }>;
      } | null;
      if (!response.ok) throw providerError("Exa", response, payload);
      return {
        provider: "exa",
        results: (payload?.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          score: result.score,
          content: result.highlights?.filter(Boolean).join("\n") || result.summary || result.text || "",
        })),
      };
    },
  };
}

function braveFreshness(startDate?: string, endDate?: string) {
  if (startDate && endDate) return `${startDate}to${endDate}`;
  return undefined;
}

function createBraveClient(apiKey: string): SearchProviderClient {
  return {
    id: "brave",
    async search(query, options) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(options.maxResults ?? 5));
      url.searchParams.set("extra_snippets", "true");
      const freshness = braveFreshness(options.startDate, options.endDate);
      if (freshness) url.searchParams.set("freshness", freshness);
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null) as {
        web?: { results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          extra_snippets?: string[];
        }> };
      } | null;
      if (!response.ok) throw providerError("Brave Search", response, payload);
      return {
        provider: "brave",
        results: (payload?.web?.results ?? []).map((result, index) => ({
          title: result.title,
          url: result.url,
          score: Math.max(0, 1 - index * 0.08),
          content: [result.description, ...(result.extra_snippets ?? [])].filter(Boolean).join("\n"),
        })),
      };
    },
  };
}

export function createSearchProviderClient(provider: SearchProviderId, apiKey: string) {
  if (provider === "exa") return createExaClient(apiKey);
  if (provider === "brave") return createBraveClient(apiKey);
  return createTavilyClient(apiKey);
}
