import { enqueueKnowledgeProfileRefresh } from "@/lib/agent/tools/knowledge-profile";
import { requireUser } from "@/lib/auth/server";
import { extractNotionPageId } from "@/lib/knowledge/notion-page-id";
import { getSupabase } from "@/lib/platform/supabase";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { input?: string; indexVersion?: string; confirm?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }
  const pageId = extractNotionPageId(body.input ?? "");
  const indexVersion = body.indexVersion?.trim();
  if (!pageId || !indexVersion || body.confirm !== true) {
    return Response.json({
      error: "回滚需要有效页面、indexVersion 和 confirm=true",
    }, { status: 400 });
  }

  const { data, error } = await getSupabase().rpc("rollback_rag_page_index", {
    p_user_id: user.id,
    p_page_id: pageId,
    p_index_version: indexVersion,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  await enqueueKnowledgeProfileRefresh({ userId: user.id });
  return Response.json({ rolledBack: true, result: data });
}
