export type MemoryLayer = "session" | "longterm" | "semantic";

export type MemoryType =
  | "preference"
  | "fact"
  | "profile"
  | "project"
  | "correction"
  | "episodic";

export type MemorySource = "user_explicit" | "inferred" | "tool";
export type MemoryStatus = "active" | "invalidated" | "conflicted";

export interface MemoryEvidence {
  excerpt: string;
  role: "user" | "tool";
  requestId?: string;
  sessionId?: string;
}

export interface MemoryRecord {
  id: string;
  key: string;
  layer: MemoryLayer;
  type: MemoryType;
  source: MemorySource;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  content: string;
  evidence: MemoryEvidence | null;
  metadata: Record<string, unknown>;
  score?: number;
  createdAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
  lastAccessedAt: string | null;
  /**
   * 乐观并发校验用。可选是因为它只存在于真实行上：
   * match_memories 之类的 RPC 若没返回该列，就拿不到版本，此时写入放弃版本校验
   * （退化成 FOR UPDATE 串行化），而不是拿一个猜的数字去校验。
   */
  version?: number;
}

export interface MemoryWriteMetadata extends Record<string, unknown> {
  type?: MemoryType;
  source?: MemorySource;
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  evidence?: MemoryEvidence | null;
}

export interface MemoryStore {
  set(
    key: string,
    content: string,
    metadata?: MemoryWriteMetadata,
    options?: { userId?: string },
  ): Promise<void>;
  get(key: string, options?: { userId?: string }): Promise<MemoryRecord | null>;
  invalidate(
    key: string,
    options?: { userId?: string; reason?: string },
  ): Promise<void>;
  forget(key: string, options?: { userId?: string }): Promise<void>;
  list(limit?: number, options?: { userId?: string }): Promise<MemoryRecord[]>;
}

export interface SemanticMemoryStore extends MemoryStore {
  recall(
    query: string,
    limit?: number,
    options?: {
      userId?: string;
      threshold?: number;
      onEmbeddingUsage?: (usage: import("@/lib/knowledge/embedding").EmbeddingUsage) => void;
    },
  ): Promise<MemoryRecord[]>;
  touch(keys: string[], options?: { userId?: string }): Promise<void>;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionStore {
  append(userId: string, sessionId: string, message: SessionMessage): Promise<void>;
  getHistory(userId: string, sessionId: string): Promise<SessionMessage[]>;
  clear(userId: string, sessionId: string): Promise<void>;
}
