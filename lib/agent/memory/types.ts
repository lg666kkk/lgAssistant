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
    options?: { userId?: string; threshold?: number },
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
