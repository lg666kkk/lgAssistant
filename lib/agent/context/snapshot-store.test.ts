import { describe, expect, it, vi } from "vitest";
import {
  loadContextSnapshot,
  saveContextSnapshot,
  type ContextSnapshotStoreDependencies,
} from "./snapshot-store";
import type { ContextSnapshotCache } from "./snapshot-cache";
import type { ContextSnapshot } from "./types";

function snapshot(): ContextSnapshot {
  return {
    id: "snapshot-1",
    userId: "user-1",
    sessionId: "session-1",
    version: 2,
    model: "test-model",
    policyVersion: "context-policy/v1",
    summary: "summary",
    messages: [{ role: "user", content: "hello" }],
    artifactRefs: ["artifact_id=test"],
    unresolvedItems: [],
    sourceMessageCount: 4,
    contentHash: "hash-1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:01:00.000Z",
  };
}

function rowFromSnapshot(value: ContextSnapshot) {
  return {
    id: value.id,
    user_id: value.userId,
    session_id: value.sessionId,
    version: value.version,
    model: value.model,
    policy_version: value.policyVersion,
    summary: value.summary,
    messages: value.messages,
    artifact_refs: value.artifactRefs,
    unresolved_items: value.unresolvedItems,
    source_message_count: value.sourceMessageCount,
    content_hash: value.contentHash,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function cache(overrides: Partial<ContextSnapshotCache> = {}): ContextSnapshotCache {
  return {
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    ...overrides,
  };
}

function loadSupabase(result: { data: unknown; error: unknown }) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => result),
  };
  const from = vi.fn(() => query);
  return { client: { from }, from };
}

function dependencies(input: {
  cache: ContextSnapshotCache;
  supabase?: any;
  configured?: boolean;
  onCacheError?: ContextSnapshotStoreDependencies["onCacheError"];
}): ContextSnapshotStoreDependencies {
  return {
    cache: input.cache,
    getSupabase: vi.fn(() => input.supabase ?? { from: vi.fn() }),
    hasSupabaseConfig: vi.fn(() => input.configured ?? true),
    onCacheError: input.onCacheError ?? vi.fn(),
  };
}

function writeSupabase(commit: () => Promise<{ data: unknown; error: unknown }>) {
  const query = { update: vi.fn(), insert: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: commit };
  for (const name of ["update", "insert", "eq", "select"] as const) query[name].mockReturnValue(query);
  return { from: vi.fn(() => query), query };
}

describe("context snapshot storage", () => {
  it("returns a Redis hit without querying Supabase", async () => {
    const value = snapshot();
    const snapshotCache = cache({ load: vi.fn(async () => value) });
    const deps = dependencies({ cache: snapshotCache });

    await expect(loadContextSnapshot({ userId: "user-1", sessionId: "session-1" }, deps))
      .resolves.toEqual(value);
    expect(deps.getSupabase).not.toHaveBeenCalled();
  });

  it("falls back to Supabase on a cache miss and backfills Redis", async () => {
    const value = snapshot();
    const snapshotCache = cache();
    const supabase = loadSupabase({ data: rowFromSnapshot(value), error: null });
    const deps = dependencies({ cache: snapshotCache, supabase: supabase.client });

    await expect(loadContextSnapshot({ userId: "user-1", sessionId: "session-1" }, deps))
      .resolves.toEqual(value);
    expect(snapshotCache.save).toHaveBeenCalledWith(value);
  });

  it("falls back to Supabase when Redis is unavailable", async () => {
    const value = snapshot();
    const cacheError = new Error("redis unavailable");
    const snapshotCache = cache({ load: vi.fn(async () => { throw cacheError; }) });
    const supabase = loadSupabase({ data: rowFromSnapshot(value), error: null });
    const onCacheError = vi.fn();
    const deps = dependencies({
      cache: snapshotCache,
      supabase: supabase.client,
      onCacheError,
    });

    await expect(loadContextSnapshot({ userId: "user-1", sessionId: "session-1" }, deps))
      .resolves.toEqual(value);
    expect(onCacheError).toHaveBeenCalledWith("load", cacheError);
  });

  it("writes Supabase before updating the Redis cache", async () => {
    const order: string[] = [];
    const snapshotCache = cache({
      save: vi.fn(async () => { order.push("redis"); }),
    });
    const commit = vi.fn(async () => {
      order.push("supabase");
      return { data: { id: "snapshot-1" }, error: null };
    });
    const deps = dependencies({
      cache: snapshotCache,
      supabase: writeSupabase(commit),
    });

    await saveContextSnapshot(snapshot(), deps);

    expect(order).toEqual(["supabase", "redis"]);
  });

  it("uses Redis as the snapshot store when Supabase is not configured", async () => {
    const snapshotCache = cache();
    const deps = dependencies({ cache: snapshotCache, configured: false });
    const value = snapshot();

    await saveContextSnapshot(value, deps);

    expect(snapshotCache.save).toHaveBeenCalledWith(value);
    expect(deps.getSupabase).not.toHaveBeenCalled();
  });

  it("keeps a successful Supabase save when the cache update fails", async () => {
    const cacheError = new Error("redis unavailable");
    const snapshotCache = cache({ save: vi.fn(async () => { throw cacheError; }) });
    const onCacheError = vi.fn();
    const deps = dependencies({
      cache: snapshotCache,
      supabase: writeSupabase(vi.fn(async () => ({ data: { id: "snapshot-1" }, error: null }))),
      onCacheError,
    });

    await expect(saveContextSnapshot(snapshot(), deps)).resolves.toBeUndefined();
    expect(onCacheError).toHaveBeenCalledWith("save", cacheError);
  });
  it("rejects a stale version and invalidates its cached snapshot", async () => {
    const snapshotCache = cache();
    const supabase = writeSupabase(vi.fn(async () => ({ data: null, error: null })));
    const deps = dependencies({ cache: snapshotCache, supabase });
    await expect(saveContextSnapshot(snapshot(), deps)).rejects.toThrow("版本冲突");
    expect(supabase.query.eq).toHaveBeenCalledWith("version", 1);
    expect(snapshotCache.save).not.toHaveBeenCalled();
    expect(snapshotCache.clear).toHaveBeenCalled();
  });

  it("does not upsert over an existing first snapshot", async () => {
    const snapshotCache = cache();
    const supabase = writeSupabase(vi.fn(async () => ({ data: null, error: { code: "23505" } })));
    await expect(saveContextSnapshot({ ...snapshot(), version: 1 }, dependencies({ cache: snapshotCache, supabase }))).rejects.toThrow("版本冲突");
    expect(supabase.query.insert).toHaveBeenCalled();
    expect(supabase.query.update).not.toHaveBeenCalled();
  });

});
