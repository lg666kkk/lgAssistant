import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { requireUser } from "@/lib/auth/server";

// GET /api/traces?limit=50
// 返回 trace 列表（不含 steps 明细，只要列表展示需要的概览字段）。
// steps/metrics 是 JSONB 大字段，列表页不需要，留给详情页按 id 拉。
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  if (!hasSupabaseConfig()) {
    return Response.json(
      { error: "未配置 Supabase，无法读取 trace" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

  // 通过 agent_traces.session_id → sessions(id) 外键内嵌会话标题，
  // 前端按 session 分组时直接用，避免再发一次查询。
  const { data, error } = await getSupabase()
    .from("agent_traces")
    .select(
      "id, request_id, session_id, stop_reason, completed, total_duration_ms, metrics, created_at, sessions(title)",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // 把内嵌的 sessions.title 拍平成顶层 session_title，前端用起来更直接
  const traces = (data ?? []).map((t: any) => ({
    ...t,
    session_title: t.sessions?.title ?? null,
    sessions: undefined,
  }));

  return Response.json({ traces });
}
