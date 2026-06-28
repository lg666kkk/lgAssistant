import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import { EmbeddingClient } from "@/lib/server/embedding";
import type { MemoryRecord, SemanticMemoryStore } from "./types";

const TABLE = "agent_semantic_memories";
const MATCH_FN = "match_memories";
// get/list 用：不取 embedding（1024 维白传），列出其余字段
const COLS = "id, key, layer, content, metadata, created_at";

/**
 * 语义记忆实现：按相似度召回（recall），存 Supabase + pgvector。
 * 实现 SemanticMemoryStore（= MemoryStore 的 get/set/forget/list + recall）。
 * 调用方只给文本，向量在内部生成 —— 调用方完全不感知 embedding 的存在。
 */
export class SemanticStore implements SemanticMemoryStore {
  // 懒加载 EmbeddingClient：它构造时校验 DASHSCOPE_API_KEY，不能在模块加载时就 new
  private embedder: EmbeddingClient | null = null;
  private getEmbedder(): EmbeddingClient {
    if (!this.embedder) this.embedder = new EmbeddingClient();
    return this.embedder;
  }

  // db 行 → MemoryRecord。语义层有 score（相似度），但仅 recall 的行才带 similarity
  private toRecord(row: any): MemoryRecord {
    const record: MemoryRecord = {
      id: row.id,
      key: row.key,
      layer: row.layer ?? "semantic",
      content: row.content,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
    };
    // 只有 recall（match_memories）的行才有 similarity；get/list 没有，就不设 score
    if (row.similarity != null) record.score = row.similarity;
    return record;
  }

  async set(
    key: string,
    content: string,
    metadata: Record<string, unknown> = {},
    options: { userId?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    // 内容变了向量必须跟着变，否则存的是新文本旧向量，recall 会按旧语义召回
    const embedding = await this.getEmbedder().embedSingle(content);
    const { error } = await getSupabase()
      .from(TABLE)
      .upsert(
        {
          user_id: options.userId,
          key,
          content,
          embedding,
          metadata: { ...metadata, userId: options.userId },
          updated_at: new Date().toISOString(),
        },
        options.userId ? { onConflict: "user_id,key" } : { onConflict: "key" },
      );
    if (error) {
      console.error("[SemanticStore.set] 写入失败:", error.message);
    }
  }

  async get(key: string, options: { userId?: string } = {}): Promise<MemoryRecord | null> {
    if (!hasSupabaseConfig()) return null;
    let query = getSupabase()
      .from(TABLE)
      .select(COLS)
      .eq("key", key);
    if (options.userId) query = query.eq("user_id", options.userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("[SemanticStore.get] 读取失败:", error.message);
      return null;
    }
    return data ? this.toRecord(data) : null;
  }

  async forget(key: string, options: { userId?: string } = {}): Promise<void> {
    if (!hasSupabaseConfig()) return;
    let query = getSupabase().from(TABLE).delete().eq("key", key);
    if (options.userId) query = query.eq("user_id", options.userId);
    const { error } = await query;
    if (error) {
      console.error("[SemanticStore.forget] 删除失败:", error.message);
    }
  }

  async list(limit = 50, options: { userId?: string } = {}): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    let query = getSupabase()
      .from(TABLE)
      .select(COLS)
      .order("created_at", { ascending: false });
    if (options.userId) query = query.eq("user_id", options.userId);
    const { data, error } = await query.limit(limit);
    if (error) {
      console.error("[SemanticStore.list] 列表失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row));
  }

  // ⭐ 主角：按语义相似度召回
  async recall(query: string, limit = 5, options: { userId?: string } = {}): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    const queryEmbedding = await this.getEmbedder().embedSingle(query);
    const { data, error } = await getSupabase().rpc(MATCH_FN, {
      query_embedding: queryEmbedding,
      match_count: limit,
      filter_user_id: options.userId ?? null,
      // match_threshold 不传，用 SQL 默认 0.3
    });
    if (error) {
      console.error("[SemanticStore.recall] 召回失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row));
  }
}
