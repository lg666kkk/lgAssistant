export type MemoryLayer = 'session' | 'longterm' | 'semantic'

export interface MemoryRecord {
  id: string;                                    // db 自动生成的主键
  key: string;                                   // 业务键：set/get/forget 用它配对
  layer: MemoryLayer;  // 哪一层
  content: string;                               // 记忆正文
  metadata: Record<string, unknown>;             // 灵活字段（user_id、来源、时间等）
  score?: number;                                // 仅语义召回有：相似度
  createdAt: string;
}
// 记忆的基类
export interface MemoryStore {
    set(key: string, content: string, metadata?: Record<string, unknown>, options?: { userId?: string }): Promise<void>;
    get(key: string, options?: { userId?: string }): Promise<MemoryRecord | null>;
    forget(key: string, options?: { userId?: string }): Promise<void>;
    list(limit?: number, options?: { userId?: string }): Promise<MemoryRecord[]>;
}

export interface SemanticMemoryStore extends MemoryStore {
    recall(query: string, limit?: number, options?: { userId?: string }): Promise<MemoryRecord[]>;
}

// ── 会话记忆（Redis）────────────────────────────────────────────
// 访问模式和 MemoryStore 完全不同（列表追加/读取），所以独立接口不继承。

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SessionStore {
  // 往会话历史追加一条消息
  append(userId: string, sessionId: string, message: SessionMessage): Promise<void>;
  // 读出整个会话历史（按时间顺序）
  getHistory(userId: string, sessionId: string): Promise<SessionMessage[]>;
  // 清空会话（对话结束时调用）
  clear(userId: string, sessionId: string): Promise<void>;
}
