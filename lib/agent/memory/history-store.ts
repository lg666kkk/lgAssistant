import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { EmbeddingClient } from "@/lib/knowledge/embedding";

/**
 * 记忆历史的只读访问层（search_memory_history 工具的数据源）。
 *
 * 为什么单独一个 store 而不是塞进 SemanticStore：
 * 语义层的职责是「按相似度找当前有效的记忆」，历史层的职责是「沿两根时间轴
 * 回放某个 key 的变更」。前者读 agent_semantic_memories 且只关心 active，
 * 后者读 agent_memory_history + 当前行且刻意不看 status。
 * 混在一个类里，`status = 'active'` 这个过滤条件就会在两种语义之间反复搬家。
 *
 * 安全约定（service-role 会绕过 RLS，见 user-isolation.test.ts）：
 * 每个方法都必须显式收到 userId，且每条查询都显式带 user_id 过滤。
 * 缺 userId 时返回空，不发出任何请求 —— 少了这条，条件退化成跨用户匹配。
 */

const HISTORY_TABLE = "agent_memory_history";
const LONGTERM_TABLE = "agent_memories";
const HISTORY_MATCH_FN = "match_memories_for_history";

const HISTORY_COLS =
  "key, content, memory_type, source, confidence, importance, status, version, effective_from, effective_to, recorded_at, superseded_at, supersede_kind, reason";

export type MemoryHistoryMode = "truth_as_of" | "recorded_history";

export type MemoryTimelineEntry = {
  key: string;
  content: string;
  memoryType: string;
  source: string;
  confidence: number;
  version: number;
  /** 有效轴：现实世界里这个事实何时为真。当前行的 effectiveTo 为 null（= 至今）。 */
  effectiveFrom: string;
  effectiveTo: string | null;
  /** 记录轴：系统何时记下它、何时不再采信。当前行的 supersededAt 为 null。 */
  recordedAt: string;
  supersededAt: string | null;
  /** 当前行没有 supersedeKind（它还没被取代）。 */
  supersedeKind: "evolution" | "correction" | "invalidation" | null;
  reason: string | null;
  isCurrent: boolean;
  /** supersede_kind = 'correction' 时为 true：该记录从未生效，是误记。 */
  neverEffective: boolean;
};

export type ResolvedHistoryKey = {
  key: string;
  content: string;
  status: string;
  similarity: number;
};

function toTimelineEntry(row: any): MemoryTimelineEntry {
  const supersedeKind = row.supersede_kind ?? null;
  return {
    key: String(row.key),
    content: String(row.content ?? ""),
    memoryType: String(row.memory_type ?? "fact"),
    source: String(row.source ?? "inferred"),
    confidence: Number(row.confidence ?? 0),
    version: Number(row.version ?? 1),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    recordedAt: String(row.recorded_at),
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    supersedeKind,
    reason: row.reason ? String(row.reason) : null,
    isCurrent: false,
    // correction 的有效区间长度为零：旧值从未为真。
    // 不标出来，模型会把误记当成「曾经的事实」讲给用户听。
    neverEffective: supersedeKind === "correction",
  };
}

export class MemoryHistoryStore {
  private embedder: EmbeddingClient | null = null;
  private getEmbedder(): EmbeddingClient {
    if (!this.embedder) this.embedder = new EmbeddingClient();
    return this.embedder;
  }

  /**
   * 语义解析 query → 业务 key。
   * 走 match_memories_for_history（不过滤 status）：历史查询的目标常常正是
   * 已经 invalidated、只剩历史意义的 key，用 match_memories 会恰好把它滤掉。
   */
  async resolveKeys(
    query: string,
    options: { userId?: string; limit?: number; threshold?: number },
  ): Promise<ResolvedHistoryKey[]> {
    if (!hasSupabaseConfig()) return [];
    if (!options.userId) return [];

    const embedding = await this.getEmbedder().embedSingle(query);
    const { data, error } = await getSupabase().rpc(HISTORY_MATCH_FN, {
      query_embedding: embedding,
      match_count: options.limit ?? 5,
      filter_user_id: options.userId,
      ...(typeof options.threshold === "number"
        ? { match_threshold: options.threshold }
        : {}),
    });
    if (error) {
      console.error("[MemoryHistoryStore.resolveKeys] key 解析失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => ({
      key: String(row.key),
      content: String(row.content ?? ""),
      status: String(row.status ?? "active"),
      similarity: Number(row.similarity ?? 0),
    }));
  }

  /**
   * mode = recorded_history：系统先后记录过什么，按 superseded_at 倒序。
   * 含 correction（打了 neverEffective 标记），因为「系统曾经记错」本身就是
   * 这个模式要回答的问题。
   *
   * asOf 在这个模式下过滤 recorded_at（「截至那时系统记下过什么」），
   * 而不是 effective_from —— 两根轴不能混用。
   */
  async recordedHistory(
    key: string,
    options: { userId?: string; limit?: number; asOf?: string },
  ): Promise<MemoryTimelineEntry[]> {
    if (!hasSupabaseConfig()) return [];
    if (!options.userId) return [];

    let query = getSupabase()
      .from(HISTORY_TABLE)
      .select(HISTORY_COLS)
      .eq("user_id", options.userId)
      .eq("key", key);
    if (options.asOf) query = query.lte("recorded_at", options.asOf);

    const { data, error } = await query
      .order("superseded_at", { ascending: false })
      .limit(options.limit ?? 5);
    if (error) {
      console.error("[MemoryHistoryStore.recordedHistory] 读取失败:", error.message);
      return [];
    }
    return (data ?? []).map(toTimelineEntry);
  }

  /**
   * mode = truth_as_of：某时刻现实中什么为真，走有效轴。
   * correction 的区间长度为零，`effective_from <= asOf AND effective_to > asOf`
   * 天然把它排除掉 —— 这正是想要的：它从未为真，不该出现在「当时什么为真」里。
   */
  async truthAsOf(
    key: string,
    asOf: string,
    options: { userId?: string },
  ): Promise<MemoryTimelineEntry[]> {
    if (!hasSupabaseConfig()) return [];
    if (!options.userId) return [];

    const { data, error } = await getSupabase()
      .from(HISTORY_TABLE)
      .select(HISTORY_COLS)
      .eq("user_id", options.userId)
      .eq("key", key)
      .lte("effective_from", asOf)
      .gt("effective_to", asOf)
      .order("effective_to", { ascending: false })
      .limit(5);
    if (error) {
      console.error("[MemoryHistoryStore.truthAsOf] 读取失败:", error.message);
      return [];
    }
    return (data ?? []).map(toTimelineEntry);
  }

  /**
   * 当前行。时间线必须 UNION 它，否则「我的预算变化过程」只能看到被取代的 5w，
   * 看不到现在的 8w —— 用户看到一条断尾的时间线，还会以为 5w 仍然有效。
   *
   * 读 agent_memories（长期层）而不是语义层：它是写入路径的权威当前值，
   * upsert_memory 的 version 也维护在这张表上。
   */
  async currentEntry(
    key: string,
    options: { userId?: string },
  ): Promise<MemoryTimelineEntry | null> {
    if (!hasSupabaseConfig()) return null;
    if (!options.userId) return null;

    const { data, error } = await getSupabase()
      .from(LONGTERM_TABLE)
      .select(
        "key, content, memory_type, source, confidence, importance, status, version, valid_from, valid_to, created_at",
      )
      .eq("user_id", options.userId)
      .eq("key", key)
      .maybeSingle();
    if (error) {
      console.error("[MemoryHistoryStore.currentEntry] 读取失败:", error.message);
      return null;
    }
    if (!data) return null;

    const row = data as any;
    return {
      key: String(row.key),
      content: String(row.content ?? ""),
      memoryType: String(row.memory_type ?? "fact"),
      source: String(row.source ?? "inferred"),
      confidence: Number(row.confidence ?? 0),
      version: Number(row.version ?? 1),
      effectiveFrom: String(row.valid_from ?? row.created_at),
      // valid_to 非空说明这条已被软失效：它有明确的失效时刻，不是「至今有效」。
      effectiveTo: row.valid_to ? String(row.valid_to) : null,
      recordedAt: String(row.created_at ?? row.valid_from),
      supersededAt: null,
      supersedeKind: null,
      reason: null,
      isCurrent: true,
      neverEffective: false,
    };
  }
}
