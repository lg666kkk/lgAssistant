import { describe, expect, it, vi } from "vitest";
import {
  buildCacheKey,
  QueryResultCache,
  type RetrievalCacheKey,
} from "./query-cache";

const baseKey = {
  tenantId: "tenant-1",
  indexVersion: "index-1",
  source: "knowledge" as const,
  query: " RAG Cache ",
  strategyVersion: "v1",
};

describe("query result cache", () => {
  it("isolates entries by tenant and index version", () => {
    expect(buildCacheKey(baseKey)).not.toBe(buildCacheKey({
      ...baseKey,
      tenantId: "tenant-2",
    }));
    expect(buildCacheKey(baseKey)).not.toBe(buildCacheKey({
      ...baseKey,
      indexVersion: "index-2",
    }));
  });

  it("normalizes filter order and returns defensive clones", () => {
    const first: RetrievalCacheKey = {
      ...baseKey,
      filters: { pageIds: ["b", "a"], sourceTypes: ["notion", "document"] },
    };
    const second: RetrievalCacheKey = {
      ...baseKey,
      filters: { sourceTypes: ["document", "notion"], pageIds: ["a", "b"] },
    };
    expect(buildCacheKey(first)).toBe(buildCacheKey(second));

    const cache = new QueryResultCache<{ values: string[] }>();
    cache.set(first, { values: ["one"] });
    const value = cache.get(second)!;
    value.values.push("mutated");
    expect(cache.get(first)).toEqual({ values: ["one"] });
  });

  it("expires entries after the configured TTL", () => {
    vi.useFakeTimers();
    const cache = new QueryResultCache<string>(1_000);
    cache.set(baseKey, "value");
    vi.advanceTimersByTime(1_001);
    expect(cache.get(baseKey)).toBeUndefined();
    vi.useRealTimers();
  });

  it("isolates web entries by search depth", () => {
    const webKey: RetrievalCacheKey = {
      ...baseKey,
      source: "web",
      indexVersion: "web-live",
      searchDepth: "basic",
    };
    expect(buildCacheKey(webKey)).not.toBe(buildCacheKey({
      ...webKey,
      searchDepth: "advanced",
    }));
  });
});
