import { createRedisClient, type RedisCommandClient } from "@/lib/platform/redis";
import type { ContextSnapshot } from "./types";

export const CONTEXT_SNAPSHOT_CACHE_TTL_SECONDS = 2 * 60 * 60;

type SnapshotRedisClient = Pick<RedisCommandClient, "get" | "setex" | "del">;

export type ContextSnapshotCache = {
  load(input: { userId: string; sessionId: string }): Promise<ContextSnapshot | null>;
  save(snapshot: ContextSnapshot): Promise<void>;
  clear(input: { userId: string; sessionId: string }): Promise<void>;
};

function snapshotKey(userId: string, sessionId: string) {
  return `context-snapshot:${userId}:${sessionId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isContextSnapshot(
  value: unknown,
  expected: { userId: string; sessionId: string },
): value is ContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<ContextSnapshot>;
  return snapshot.userId === expected.userId
    && snapshot.sessionId === expected.sessionId
    && typeof snapshot.id === "string"
    && Number.isInteger(snapshot.version)
    && typeof snapshot.model === "string"
    && typeof snapshot.policyVersion === "string"
    && typeof snapshot.summary === "string"
    && Array.isArray(snapshot.messages)
    && isStringArray(snapshot.artifactRefs)
    && isStringArray(snapshot.unresolvedItems)
    && Number.isInteger(snapshot.sourceMessageCount)
    && typeof snapshot.contentHash === "string"
    && typeof snapshot.createdAt === "string"
    && typeof snapshot.updatedAt === "string";
}

export class RedisContextSnapshotCache implements ContextSnapshotCache {
  constructor(
    private readonly client: SnapshotRedisClient = createRedisClient({
      errorLabel: "ContextSnapshotCache",
    }),
    private readonly ttlSeconds = CONTEXT_SNAPSHOT_CACHE_TTL_SECONDS,
  ) {}

  async load(input: { userId: string; sessionId: string }): Promise<ContextSnapshot | null> {
    const key = snapshotKey(input.userId, input.sessionId);
    const raw = await this.client.get(key);
    if (!raw) return null;

    try {
      const snapshot: unknown = JSON.parse(raw);
      if (isContextSnapshot(snapshot, input)) return snapshot;
    } catch {
      // Corrupt cache entries are treated as misses and removed below.
    }

    await this.client.del(key);
    return null;
  }

  async save(snapshot: ContextSnapshot): Promise<void> {
    await this.client.setex(
      snapshotKey(snapshot.userId, snapshot.sessionId),
      this.ttlSeconds,
      JSON.stringify(snapshot),
    );
  }

  async clear(input: { userId: string; sessionId: string }): Promise<void> {
    await this.client.del(snapshotKey(input.userId, input.sessionId));
  }
}

export const contextSnapshotCache = new RedisContextSnapshotCache();
