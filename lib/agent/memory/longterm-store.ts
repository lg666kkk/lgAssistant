import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import type { MemoryRecord, MemoryStore } from "./types";

const TABLE = "agent_memories";

/**
 * 长期记忆实现：用户偏好、成功模式等，存 Supabase(PostgreSQL)。
 * 实现 MemoryStore 主接口（不实现 recall —— 长期层没有向量）。
 */
export class LongTermStore implements MemoryStore {
  // db 行（snake_case）→ MemoryRecord（camelCase）。四个方法都复用它，避免重复映射。
  private toRecord(row: any): MemoryRecord {
    return {
      id: row.id,
      key: row.key,
      layer: row.layer,            // db 里恒为 'longterm'，直接读，不硬编码
      content: row.content,
      metadata: row.metadata ?? {}, // metadata 理论非空，兜底防 null
      createdAt: row.created_at,    // snake_case → camelCase 的关键映射
      // 注意：long-term 没有相似度，不设 score（接口里 score 是可选的）
    };
  }

  async set(
    key: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!hasSupabaseConfig()) return; // 没配 Supabase 直接跳过，和 trace-store 一致
    const { error } = await getSupabase()
      .from(TABLE)
      .upsert(
        {
          key,
          content,
          metadata,
          // 显式传 updated_at：DEFAULT NOW() 只在 INSERT 生效，
          // upsert 走 UPDATE 分支时不会自动刷新，必须手动给
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }, // key 冲突时 UPDATE 而非报错 —— 这就是「覆盖」语义
      );
    if (error) {
      console.error("[LongTermStore.set] 写入失败:", error.message);
    }
  }

  async get(key: string): Promise<MemoryRecord | null> {
    if (!hasSupabaseConfig()) return null; // 注意返回 null 不是 undefined，对齐返回类型
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select("*")
      .eq("key", key)      // WHERE key = $1
      .maybeSingle();      // 查不到返回 null（single() 会抛错，我们不要那个）
    if (error) {
      console.error("[LongTermStore.get] 读取失败:", error.message);
      return null;
    }
    return data ? this.toRecord(data) : null;
  }

  async forget(key: string): Promise<void> {
    if (!hasSupabaseConfig()) return;
    const { error } = await getSupabase()
      .from(TABLE)
      .delete()
      .eq("key", key);     // WHERE key = $1
    if (error) {
      console.error("[LongTermStore.forget] 删除失败:", error.message);
    }
  }

  async list(limit = 50): Promise<MemoryRecord[]> {
    if (!hasSupabaseConfig()) return [];
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select("*")
      .eq("layer", "longterm")
      .order("created_at", { ascending: false }) // 最新的在前
      .limit(limit);
    if (error) {
      console.error("[LongTermStore.list] 列表失败:", error.message);
      return [];
    }
    return (data ?? []).map((row: any) => this.toRecord(row)); // data 可能 null，兜底 []
  }
}
