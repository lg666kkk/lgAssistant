import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { createUserEmbeddingClient } from "@/lib/embedding-config/service";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type EmbeddingClient,
} from "@/lib/knowledge/embedding";
import { memoryColumnsFromMetadata } from "./record-mapper";
import type { MemoryWriteMetadata } from "./types";

const UPSERT_FN = "upsert_memory";
const INVALIDATE_FN = "invalidate_memory";
const PURGE_FN = "purge_memory";

/** evolution：事实变了；correction：事实一直是错的（旧值有效期归零）。 */
export type MemorySupersedeKindParam = "evolution" | "correction";

/**
 * upsert_memory 抛 40001（serialization_failure）时的类型化错误。
 * 之所以不在 writer 内部重试：重试需要一个**新的** expectedVersion，
 * 而那要重新读候选、重新做写入判定——那是 consolidate 的职责，不是 writer 的。
 * writer 盲目丢掉版本校验重试一次，等于把乐观并发退化成后写者胜。
 */
export class MemoryVersionConflictError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = "MemoryVersionConflictError";
  }
}

function isVersionConflict(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  // PostgREST 会把 plpgsql 的 SQLSTATE 放在 code；老版本只体现在 message 里。
  return error.code === "40001" || /memory_version_conflict/.test(error.message ?? "");
}

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
  /**
   * 该事实所在**用户消息**的时刻，用来截断旧版本的有效期。
   * 不能用 NOW()：固化是 fire-and-forget（route.ts 的 void consolidate），
   * 处理时刻可能比用户表达时刻晚几秒到几十秒，甚至两次固化反序完成。
   * 用 NOW() 会把处理延迟写进有效时间轴，历史区间从此不可信。
   */
  effectiveAt?: string;
  supersedeKind?: MemorySupersedeKindParam;
  /** 读候选时看到的 version；不传表示放弃并发校验（首次写入没有候选时如此）。 */
  expectedVersion?: number;
  requestId?: string;
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
    p_effective_at: input.effectiveAt ?? null,
    p_supersede_kind: input.supersedeKind ?? "evolution",
    p_expected_version: input.expectedVersion ?? null,
    p_request_id: input.requestId ?? null,
  };
}

/**
 * 用户授权的不可逆硬删除：历史表 + 语义层 + 长期层同事务清空该 key。
 *
 * 取代 LongTermStore.forget / SemanticStore.forget 各自独立 .delete() 的旧实现——
 * 那两个调用一成一败会让两层长期漂移（正是 upsert_memory 当初要解决的问题），
 * 而且它们不知道历史表的存在，删完仍能被 search_memory_history 翻出来。
 *
 * 与 memory:history:cleanup 的保留期清理是两件事：那个是运维「时间到了自动清」，
 * 这个是隐私「用户现在要求清」，谁也替代不了谁。
 *
 * @returns 三张表合计删除的行数；0 表示本来就没有这条记忆。
 */
export async function purgeMemoryKey(key: string, userId: string | undefined): Promise<number> {
  if (!hasSupabaseConfig()) return 0;
  if (!userId) {
    // 硬删除缺 userId 时绝不能放行到 RPC：service-role 绕过 RLS，
    // p_user_id 为空会让删除条件退化成跨用户匹配。
    console.warn("[purgeMemoryKey] 缺少 userId，跳过删除");
    return 0;
  }
  const { data, error } = await getSupabase().rpc(PURGE_FN, {
    p_user_id: userId,
    p_key: key,
  });
  if (error) throw new Error(`[purgeMemoryKey] 硬删除失败: ${error.message}`);
  return typeof data === "number" ? data : 0;
}

export class MemoryWriter {
  // 保留可替换的测试缝；生产默认按 userId 解析页面配置，不缓存跨用户凭据。
  private embedder: Pick<EmbeddingClient, "embedSingle"> | null = null;

  /** 原子 upsert：同事务写长期层 + 语义层。embedding 失败会在任何 DB 写之前抛出，不会产生半写。 */
  async upsert(
    key: string,
    content: string,
    metadata: MemoryWriteMetadata,
    options: {
      userId?: string;
      effectiveAt?: string;
      supersedeKind?: MemorySupersedeKindParam;
      expectedVersion?: number;
      requestId?: string;
    } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    if (!options.userId) {
      console.warn("[MemoryWriter.upsert] 缺少 userId，跳过写入");
      return;
    }
    const embeddingRuntime = this.embedder
      ? {
          client: this.embedder,
          config: {
            modelId: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
            provider: "dashscope" as const,
          },
        }
      : await createUserEmbeddingClient(options.userId);
    const embedding = await embeddingRuntime.client.embedSingle(content);
    const params = buildUpsertParams({
      userId: options.userId,
      key,
      content,
      embedding,
      metadata: {
        ...metadata,
        embedding_model: embeddingRuntime.config.modelId,
        embedding_dimensions: embeddingRuntime.config.dimensions,
        embedding_provider: embeddingRuntime.config.provider,
      },
      effectiveAt: options.effectiveAt,
      supersedeKind: options.supersedeKind,
      expectedVersion: options.expectedVersion,
      requestId: options.requestId,
    });
    const { error } = await getSupabase().rpc(UPSERT_FN, params);
    if (isVersionConflict(error)) {
      throw new MemoryVersionConflictError(key, `[MemoryWriter.upsert] 版本冲突: ${error?.message}`);
    }
    if (error) throw new Error(`[MemoryWriter.upsert] 原子写入失败: ${error.message}`);
  }

  /** 原子软失效：同事务把两层从 active → invalidated，并把旧行归档。 */
  async invalidate(
    key: string,
    options: {
      userId?: string;
      reason?: string;
      /** 用户表达失效的时刻，不是处理时刻。理由同 upsert 的 effectiveAt。 */
      effectiveAt?: string;
      requestId?: string;
    } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return;
    if (!options.userId) {
      console.warn("[MemoryWriter.invalidate] 缺少 userId，跳过失效");
      return;
    }
    const { error } = await getSupabase().rpc(INVALIDATE_FN, {
      p_user_id: options.userId,
      p_key: key,
      p_valid_to: options.effectiveAt ?? new Date().toISOString(),
      p_request_id: options.requestId ?? null,
      p_reason: options.reason ?? null,
    });
    if (error) throw new Error(`[MemoryWriter.invalidate] 原子失效失败: ${error.message}`);
  }

  /**
   * 硬删除。只有 intent === "purge" 的决策才会走到这里——模型不能把 forget
   * 自行升级成 purge（见 memory-flow 的 parseWriteDecision）。
   */
  async purge(key: string, options: { userId?: string } = {}): Promise<number> {
    return purgeMemoryKey(key, options.userId);
  }
}
