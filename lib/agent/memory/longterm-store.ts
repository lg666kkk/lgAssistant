import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { purgeMemoryKey } from "./atomic-writer";
import { memoryColumnsFromMetadata, memoryRecordFromRow } from "./record-mapper";
import type { MemoryRecord, MemoryStore, MemoryWriteMetadata } from "./types";

const TABLE = "agent_memories";

function requireUserId(options: { userId?: string }, operation: string): string | null {
  if (options.userId) return options.userId;
  console.warn(`[LongTermStore.${operation}] 缺少 userId，跳过长期记忆操作`);
  return null;
}

/**
 * 长期记忆实现：用户偏好、成功模式等，存 Supabase(PostgreSQL)。
 * 实现 MemoryStore 主接口（不实现 recall —— 长期层没有向量）。
 */
export class LongTermStore implements MemoryStore {
  private toRecord(row: any): MemoryRecord {
    return memoryRecordFromRow(row, "longterm");
  }

  async set(
    key: string,
    content: string,
    metadata: MemoryWriteMetadata = {},
    options: { userId?: string } = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return; // 没配 Supabase 直接跳过，和 trace-store 一致
    const userId = requireUserId(options, "set");
    if (!userId) return;

    const { error } = await getSupabase()
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          key,
          content,
          metadata: { ...metadata, userId },
          ...memoryColumnsFromMetadata(metadata),
          valid_from: new Date().toISOString(),
          valid_to: null,
          // 显式传 updated_at：DEFAULT NOW() 只在 INSERT 生效，
          // upsert 走 UPDATE 分支时不会自动刷新，必须手动给
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,key" },
      );
    if (error) {
      throw new Error(`[LongTermStore.set] 写入失败: ${error.message}`);
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
      .update({
        status: "invalidated",
        valid_to: now,
        updated_at: now,
      })
      .eq("key", key)
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw new Error(`[LongTermStore.invalidate] 失效失败: ${error.message}`);
  }

  async get(key: string, options: { userId?: string } = {}): Promise<MemoryRecord | null> {
    if (!hasSupabaseConfig()) return null; // 注意返回 null 不是 undefined，对齐返回类型
    const userId = requireUserId(options, "get");
    if (!userId) return null;

    const query = getSupabase()
      .from(TABLE)
      .select("*")
      .eq("key", key)
      .eq("user_id", userId);      // WHERE key = $1 AND user_id = $2
    const { data, error } = await query.maybeSingle();      // 查不到返回 null（single() 会抛错，我们不要那个）
    if (error) {
      console.error("[LongTermStore.get] 读取失败:", error.message);
      return null;
    }
    return data ? this.toRecord(data) : null;
  }

  /**
   * 一次读取多个精确 key，供写入前组装 canonical/兼容 key 候选。
   * 返回顺序与 keys 一致，数据库结果顺序不参与候选优先级判断。
   */
  async getMany(
    keys: string[],
    options: { userId?: string } = {},
  ): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig() || keys.length === 0) return [];
    const userId = requireUserId(options, "getMany");
    if (!userId) return [];

    const orderedKeys = Array.from(new Set(keys));
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select("*")
      .eq("user_id", userId)
      .in("key", orderedKeys);
    if (error) {
      console.error("[LongTermStore.getMany] 读取失败:", error.message);
      return [];
    }

    const recordsByKey = new Map<string, MemoryRecord>(
      (data ?? []).map((row: any) => {
        const record = this.toRecord(row);
        return [record.key, record] as [string, MemoryRecord];
      }),
    );
    return orderedKeys.flatMap((key) => {
      const record = recordsByKey.get(key);
      return record ? [record] : [];
    });
  }

  /**
   * 硬删除该 key。改为走 purge_memory RPC，不再只删本表：
   * 单表 .delete() 会留下另一层的孤儿行，也留下历史表里可被检索的旧版本，
   * 用户说的「彻底删掉」就没做到。
   */
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
      .select("*")
      .eq("layer", "longterm")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }) // 最新的在前
      .limit(limit);
    if (error) {
      console.error("[LongTermStore.list] 列表失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row)); // data 可能 null，兜底 []
  }
}
