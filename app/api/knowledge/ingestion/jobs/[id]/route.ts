import { requireUser } from "@/lib/auth/server";
import { getSupabase } from "@/lib/platform/supabase";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { action?: "replay" | "cancel" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }
  const update = body.action === "replay"
    ? {
        status: "queued",
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        lease_until: null,
        worker_id: null,
        last_error: null,
        retention_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        updated_at: new Date().toISOString(),
      }
    : body.action === "cancel"
      ? {
          status: "cancelled",
          lease_until: null,
          updated_at: new Date().toISOString(),
        }
      : null;
  if (!update) return Response.json({ error: "action 必须是 replay 或 cancel" }, { status: 400 });

  let query = getSupabase()
    .from("rag_ingestion_jobs")
    .update(update)
    .eq("id", params.id)
    .eq("user_id", user.id);
  query = body.action === "replay"
    ? query.in("status", ["dead", "cancelled"])
    : query.in("status", ["queued", "retry_wait"]);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "job 状态不允许该操作" }, { status: 409 });
  return Response.json({ job: data });
}
