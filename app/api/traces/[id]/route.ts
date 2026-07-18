import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { requireUser } from "@/lib/auth/server";

// GET /api/traces/:id
// 返回单条 trace 的完整明细，含 steps（model/tool 逐步时间线）和 metrics 汇总。
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  if (!hasSupabaseConfig()) {
    return Response.json(
      { error: "未配置 Supabase，无法读取 trace" },
      { status: 503 },
    );
  }

  const { data, error } = await getSupabase()
    .from("agent_traces")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "trace 不存在" }, { status: 404 });
  }

  return Response.json({ trace: data });
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const { error } = await getSupabase()
    .from("agent_traces")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ deleted: true });
}
