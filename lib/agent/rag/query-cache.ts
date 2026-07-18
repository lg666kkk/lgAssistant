import { createHash } from "node:crypto";
import type { RetrievalFilters } from "./types";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type RetrievalCacheKey = {
  tenantId: string;
  indexVersion: string;
  source: "knowledge" | "web";
  query: string;
  filters?: RetrievalFilters;
  threshold?: number;
  limit?: number;
  searchDepth?: "basic" | "advanced";
  strategyVersion: string;
};

export class QueryResultCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 200,
  ) {}

  get(key: RetrievalCacheKey): T | undefined {
    const cacheKey = buildCacheKey(key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return structuredClone(entry.value);
  }

  set(key: RetrievalCacheKey, value: T) {
    const cacheKey = buildCacheKey(key);
    this.entries.set(cacheKey, {
      value: structuredClone(value),
      expiresAt: Date.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }
}

export function buildCacheKey(key: RetrievalCacheKey) {
  return createHash("sha256")
    .update(JSON.stringify({
      tenantId: key.tenantId,
      indexVersion: key.indexVersion,
      source: key.source,
      query: key.query.trim().toLowerCase(),
      filters: normalizeFilters(key.filters),
      threshold: key.threshold,
      limit: key.limit,
      searchDepth: key.searchDepth,
      strategyVersion: key.strategyVersion,
    }))
    .digest("hex");
}

function normalizeFilters(filters?: RetrievalFilters) {
  if (!filters) return null;
  return {
    pageIds: filters.pageIds ? [...filters.pageIds].sort() : undefined,
    titleContains: filters.titleContains?.trim() || undefined,
    sourceTypes: filters.sourceTypes ? [...filters.sourceTypes].sort() : undefined,
    timeRange: filters.timeRange
      ? {
          from: filters.timeRange.from,
          to: filters.timeRange.to,
          label: filters.timeRange.label,
        }
      : undefined,
  };
}
