import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { selectTraceRequestChain } from "@/lib/agent/runtime/trace-request-chain";
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

  // Tool confirmation continuations are stored as separate trace rows but
  // link to their parent request through tool-step metadata. Only merge that
  // request chain; other queries in the same session remain independent.
  if (data.session_id) {
    const { data: related, error: relatedError } = await getSupabase()
      .from("agent_traces")
      .select("id, request_id, session_id, stop_reason, completed, total_duration_ms, steps, metrics, created_at")
      .eq("user_id", user.id)
      .eq("session_id", data.session_id)
      .order("created_at", { ascending: true });
    if (relatedError) {
      return Response.json({ error: relatedError.message }, { status: 500 });
    }
    const rows = selectTraceRequestChain(related ?? [], data);
    if (rows.length > 1) {
      const metrics = rows.reduce((sum: Record<string, any>, row: any) => {
        for (const [key, value] of Object.entries(row.metrics ?? {})) {
          if (key === "toolDurations") {
            sum[key] = [...(sum[key] ?? []), ...(Array.isArray(value) ? value : [])];
          } else if (typeof value === "number") {
            sum[key] = (sum[key] ?? 0) + value;
          } else if (sum[key] === undefined) {
            sum[key] = value;
          }
        }
        return sum;
      }, {});
      const steps = rows.flatMap((row: any) => Array.isArray(row.steps) ? row.steps : [])
        .map((step: any, index: number) => ({ ...step, index }));
      const latest = rows[rows.length - 1];
      return Response.json({
        trace: {
          ...data,
          stop_reason: latest.stop_reason,
          completed: latest.completed,
          total_duration_ms: rows.reduce((total: number, row: any) => total + (row.total_duration_ms ?? 0), 0),
          steps,
          metrics,
          request_id: data.request_id,
        },
      });
    }
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
