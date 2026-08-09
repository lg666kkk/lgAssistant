import { describe, expect, it, vi } from "vitest";
import { RedisContextSnapshotCache } from "./snapshot-cache";
import type { ContextSnapshot } from "./types";

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id: "snapshot-1",
    userId: "user-1",
    sessionId: "session-1",
    version: 1,
    model: "test-model",
    policyVersion: "context-policy/v1",
    summary: "",
    messages: [{ role: "user", content: "hello" }],
    artifactRefs: [],
    unresolvedItems: [],
    sourceMessageCount: 1,
    contentHash: "hash-1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("RedisContextSnapshotCache", () => {
  it("stores the complete snapshot with a TTL and reads it back", async () => {
    const values = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        values.set(key, value);
      }),
      del: vi.fn(async (key: string) => values.delete(key)),
    };
    const cache = new RedisContextSnapshotCache(client, 300);
    const value = snapshot();

    await cache.save(value);

    expect(client.setex).toHaveBeenCalledWith(
      "context-snapshot:user-1:session-1",
      300,
      JSON.stringify(value),
    );
    await expect(cache.load({ userId: "user-1", sessionId: "session-1" }))
      .resolves.toEqual(value);
  });

  it("removes malformed or cross-scope cache entries", async () => {
    const client = {
      get: vi.fn(async () => JSON.stringify(snapshot({ userId: "other-user" }))),
      setex: vi.fn(async () => undefined),
      del: vi.fn(async () => undefined),
    };
    const cache = new RedisContextSnapshotCache(client);

    await expect(cache.load({ userId: "user-1", sessionId: "session-1" }))
      .resolves.toBeNull();
    expect(client.del).toHaveBeenCalledWith("context-snapshot:user-1:session-1");
  });
});
