import { deleteToolArtifactsForScope } from "@/lib/agent/runtime/artifact-store";
import { RedisSessionStore } from "@/lib/agent/memory/session-store";
import { requireUser } from "@/lib/auth/server";
import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";

export const runtime = "nodejs";

const sessionStore = new RedisSessionStore();

function isSessionId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const sessionId = params.id;
  if (!isSessionId(sessionId)) {
    return Response.json({ error: "无效的会话 ID" }, { status: 400 });
  }
  if (!hasSupabaseConfig()) {
    return Response.json({ error: "未配置 Supabase，无法删除会话" }, { status: 503 });
  }

  // artifact 是会话记录的外部依赖；失败时保留数据库记录，允许用户重试删除。
  try {
    await deleteToolArtifactsForScope({ userId: user.id, scopeId: sessionId });
  } catch (error) {
    console.error("[session] 清理本地 artifact 失败:", error);
    return Response.json({ error: "清理会话本地数据失败，请重试" }, { status: 500 });
  }

  // Redis 只承担短期会话缓存，不应影响正式会话和 artifact 的删除。
  await sessionStore.clear(user.id, sessionId).catch((error) =>
    console.error("[session] 清理 Redis 会话缓存失败:", error),
  );

  const { data, error } = await getSupabase()
    .from("sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .select("id");

  if (error) {
    return Response.json({ error: `删除会话失败: ${error.message}` }, { status: 500 });
  }

  return Response.json({ deleted: (data?.length ?? 0) > 0 });
}
