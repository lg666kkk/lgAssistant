import { requireUser } from "@/lib/auth/server";
import { getSupabase } from "@/lib/platform/supabase";

export const runtime = "nodejs";

function countsBy(rows: Array<Record<string, unknown>>, key: string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = String(row[key] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const supabase = getSupabase();
    const [memoryResult, historyResult] = await Promise.all([
      supabase.from("agent_memories")
        .select("id,key,content,memory_type,source,confidence,importance,status,evidence,created_at,updated_at,valid_from,valid_to,last_accessed_at,version")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(500),
      supabase.from("agent_memory_history")
        .select("id,key,content,memory_type,source,confidence,importance,status,recorded_at,superseded_at,effective_from,effective_to,version,supersede_kind,reason")
        .eq("user_id", user.id)
        .order("superseded_at", { ascending: false })
        .limit(200),
    ]);
    if (memoryResult.error) throw new Error(`读取记忆失败: ${memoryResult.error.message}`);
    if (historyResult.error) throw new Error(`读取记忆历史失败: ${historyResult.error.message}`);
    const memories = (memoryResult.data ?? []) as Array<Record<string, unknown>>;
    const history = (historyResult.data ?? []) as Array<Record<string, unknown>>;
    return Response.json({
      summary: {
        total: memories.length,
        active: memories.filter((row) => row.status === "active").length,
        invalidated: memories.filter((row) => row.status === "invalidated").length,
        conflicted: memories.filter((row) => row.status === "conflicted").length,
        historyVersions: history.length,
        byType: countsBy(memories, "memory_type"),
        bySource: countsBy(memories, "source"),
      },
      memories,
      history,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取记忆数据失败" }, { status: 503 });
  }
}
