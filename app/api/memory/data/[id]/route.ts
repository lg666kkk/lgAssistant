import { requireUser } from "@/lib/auth/server";
import { getSupabase } from "@/lib/platform/supabase";
import { purgeMemoryKey } from "@/lib/agent/memory/atomic-writer";

export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const { data, error } = await getSupabase().from("agent_memories")
      .select("id,key")
      .eq("id", params.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw new Error(`校验记忆归属失败: ${error.message}`);
    if (!data) return Response.json({ error: "记忆不存在或无权访问" }, { status: 404 });
    const deletedCount = await purgeMemoryKey(String(data.key), user.id);
    return Response.json({ ok: true, key: data.key, deletedCount });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除记忆失败" }, { status: 400 });
  }
}
