import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { EmbeddingClient } from "@/lib/knowledge/embedding";
import { purgeMemoryKey } from "./atomic-writer";
import { memoryColumnsFromMetadata, memoryRecordFromRow } from "./record-mapper";
import type { MemoryRecord, MemoryWriteMetadata, SemanticMemoryStore } from "./types";

const TABLE = "agent_semantic_memories";
const MATCH_FN = "match_memories";
const KEYWORD_MATCH_FN = "match_memories_keyword";
// get/list 用：不取 embedding（1024 维白传），列出其余字段
const COLS = "id, key, layer, memory_type, source, confidence, importance, status, content, evidence, metadata, created_at, updated_at, valid_from, valid_to, last_accessed_at";

function requireUserId(options: { userId?: string }, operation: string): string | null {
  if (options.userId) return options.userId;
  console.warn(`[SemanticStore.${operation}] 缺少 userId，跳过语义记忆操作`);
  return null;
}

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
    return memoryRecordFromRow(row, "semantic");
  }

  async set(
    key: string,
    content: string,
    metadata: MemoryWriteMetadata = {},
    options: { userId?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    const userId = requireUserId(options, "set");
    if (!userId) return;

    // 内容变了向量必须跟着变，否则存的是新文本旧向量，recall 会按旧语义召回
    const embedding = await this.getEmbedder().embedSingle(content);
    const { error } = await getSupabase()
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          key,
          content,
          embedding,
          metadata: { ...metadata, userId },
          ...memoryColumnsFromMetadata(metadata),
          valid_from: new Date().toISOString(),
          valid_to: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,key" },
      );
    if (error) {
      throw new Error(`[SemanticStore.set] 写入失败: ${error.message}`);
    }
  }

  async invalidate(
    key: string,
    options: { userId?: string; reason?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    const userId = requireUserId(options, "invalidate");
    if (!userId) return;

    const now = new Date().toISOString();
    const { error } = await getSupabase()
      .from(TABLE)
      .update({ status: "invalidated", valid_to: now, updated_at: now })
      .eq("key", key)
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw new Error(`[SemanticStore.invalidate] 失效失败: ${error.message}`);
  }

  async get(key: string, options: { userId?: string } = {}): Promise<MemoryRecord | null> {
    if (!hasSupabaseConfig()) return null;
    const userId = requireUserId(options, "get");
    if (!userId) return null;

    const query = getSupabase()
      .from(TABLE)
      .select(COLS)
      .eq("key", key)
      .eq("user_id", userId);
    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("[SemanticStore.get] 读取失败:", error.message);
      return null;
    }
    return data ? this.toRecord(data) : null;
  }

  /** 同 LongTermStore.forget：走 purge_memory RPC，三张表同事务删除。 */
  async forget(key: string, options: { userId?: string } = {}): Promise<void> {
    if (!hasSupabaseConfig()) return;
    const userId = requireUserId(options, "forget");
    if (!userId) return;
    await purgeMemoryKey(key, userId);
  }

  async list(limit = 50, options: { userId?: string } = {}): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    const userId = requireUserId(options, "list");
    if (!userId) return [];

    const { data, error } = await getSupabase()
      .from(TABLE)
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[SemanticStore.list] 列表失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row));
  }

  async touch(keys: string[], options: { userId?: string } = {}): Promise<void> {
    if (!hasSupabaseConfig() || keys.length === 0) return;
    const userId = requireUserId(options, "touch");
    if (!userId) return;

    const { error } = await getSupabase()
      .from(TABLE)
      .update({ last_accessed_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("key", Array.from(new Set(keys)));
    if (error) console.error("[SemanticStore.touch] 更新访问时间失败:", error.message);
  }

  // ⭐ 主角：按语义相似度召回
  async recall(
    query: string,
    limit = 5,
    options: { userId?: string; threshold?: number } = {},
  ): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    const userId = requireUserId(options, "recall");
    if (!userId) return [];

    const queryEmbedding = await this.getEmbedder().embedSingle(query);
    const { data, error } = await getSupabase().rpc(MATCH_FN, {
      query_embedding: queryEmbedding,
      match_count: limit,
      filter_user_id: userId,
      // 长期记忆调用方传入显式阈值，避免依赖 SQL 中偏宽松的默认值。
      ...(typeof options.threshold === "number"
        ? { match_threshold: options.threshold }
        : {}),
    });
    if (error) {
      console.error("[SemanticStore.recall] 召回失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row));
  }

  /**
   * 关键词通道召回。terms 由 keyword-terms.ts 在应用层切好，这里只透传。
   *
   * 与 recall 的关系是并列的两条通道，不是主备：向量分不开数字（「8 万」与
   * 「5 万」的余弦距离小到可忽略），关键词认不出同义改写。两条结果交给
   * fusion.ts 合并（并集）。
   *
   * 返回记录的 score 是 keyword_rank（命中词数 / 总词数，或受控 key 命中的 1.0），
   * **与 recall 返回的余弦相似度不同量纲**，不能直接放在一起比大小 ——
   * 这正是融合器要做校准的原因。
   *
   * 查询失败返回空数组而不抛：关键词通道是增强项，迁移还没跑（RPC 不存在）时
   * 整条召回链路必须仍然可用，退化成纯向量。
   */
  async recallByKeyword(
    input: { terms: string[]; keys: string[] },
    limit = 12,
    options: { userId?: string } = {},
  ): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    const userId = requireUserId(options, "recallByKeyword");
    if (!userId) return [];
    if (input.terms.length === 0 && input.keys.length === 0) return [];

    const { data, error } = await getSupabase().rpc(KEYWORD_MATCH_FN, {
      p_user_id: userId,
      p_terms: input.terms,
      p_keys: input.keys,
      p_match_count: limit,
    });
    if (error) {
      console.error("[SemanticStore.recallByKeyword] 关键词召回失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => {
      const record = this.toRecord(row);
      // record-mapper 只认 similarity 列，keyword_rank 得在这里补进 score。
      if (row.keyword_rank != null) record.score = Number(row.keyword_rank);
      return record;
    });
  }
}
