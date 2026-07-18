import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { EmbeddingClient } from "@/lib/knowledge/embedding";
import { memoryColumnsFromMetadata } from "./record-mapper";
import type { MemoryWriteMetadata } from "./types";

const UPSERT_FN = "upsert_memory";
const INVALIDATE_FN = "invalidate_memory";

/**
 * 原子记忆写入器：长期层与语义层的双写收敛到单个 Postgres 事务（RPC）。
 * 取代 memory-flow 里 Promise.all([longTerm.set, semantic.set]) 的非原子双写——
 * 那种写法一成一败会让两层长期漂移（长期有、语义无，或反之），且只能靠日志发现。
 * 两张表同库，plpgsql 函数天然在一个事务里，任一步失败整体回滚，比 outbox 轻。
 */
export function buildUpsertParams(input: {
  userId: string;
  key: string;
  content: string;
  embedding: number[];
  metadata: MemoryWriteMetadata;
  now?: string;
}) {
  const columns = memoryColumnsFromMetadata(input.metadata);
  return {
    p_user_id: input.userId,
    p_key: input.key,
    p_content: input.content,
    p_embedding: input.embedding,
    // metadata jsonb 仍冗余保存全量（含 userId），和旧 store.set 行为一致
    p_metadata: { ...input.metadata, userId: input.userId },
    p_memory_type: columns.memory_type,
    p_source: columns.source,
    p_confidence: columns.confidence,
    p_importance: columns.importance,
    p_status: columns.status,
    p_evidence: columns.evidence,
    p_valid_from: input.now ?? new Date().toISOString(),
    p_valid_to: null as string | null,
  };
}

export class MemoryWriter {
  // 懒加载：EmbeddingClient 构造时校验 DASHSCOPE_API_KEY，不能在模块加载期就 new
  private embedder: EmbeddingClient | null = null;
  private getEmbedder(): EmbeddingClient {
    if (!this.embedder) this.embedder = new EmbeddingClient();
    return this.embedder;
  }

  /** 原子 upsert：同事务写长期层 + 语义层。embedding 失败会在任何 DB 写之前抛出，不会产生半写。 */
  async upsert(
    key: string,
    content: string,
    metadata: MemoryWriteMetadata,
    options: { userId?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    if (!options.userId) {
      console.warn("[MemoryWriter.upsert] 缺少 userId，跳过写入");
      return;
    }
    const embedding = await this.getEmbedder().embedSingle(content);
    const params = buildUpsertParams({
      userId: options.userId,
      key,
      content,
      embedding,
      metadata,
    });
    const { error } = await getSupabase().rpc(UPSERT_FN, params);
    if (error) throw new Error(`[MemoryWriter.upsert] 原子写入失败: ${error.message}`);
  }

  /** 原子软失效：同事务把两层从 active → invalidated。 */
  async invalidate(
    key: string,
    options: { userId?: string; reason?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    if (!options.userId) {
      console.warn("[MemoryWriter.invalidate] 缺少 userId，跳过失效");
      return;
    }
    const { error } = await getSupabase().rpc(INVALIDATE_FN, {
      p_user_id: options.userId,
      p_key: key,
      p_valid_to: new Date().toISOString(),
    });
    if (error) throw new Error(`[MemoryWriter.invalidate] 原子失效失败: ${error.message}`);
  }
}
