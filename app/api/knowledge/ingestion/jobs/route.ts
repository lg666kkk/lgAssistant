import { requireUser } from "@/lib/auth/server";
import { enqueueRagIngestionJob } from "@/lib/knowledge/ingestion-queue";
import { extractNotionPageId } from "@/lib/knowledge/notion-page-id";
import { getSupabase } from "@/lib/platform/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  let query = getSupabase()
    .from("rag_ingestion_jobs")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ jobs: data ?? [] });
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { input?: string; tree?: boolean; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }
  const pageId = extractNotionPageId(body.input ?? "");
  if (!pageId) {
    return Response.json({ error: "请输入有效的 Notion 页面链接或页面 ID" }, { status: 400 });
  }
  try {
    const job = await enqueueRagIngestionJob({
      userId: user.id,
      pageId,
      tree: body.tree,
      force: body.force,
    });
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "创建 ingestion job 失败",
    }, { status: 500 });
  }
}
