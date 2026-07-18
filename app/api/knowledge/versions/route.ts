import { requireUser } from "@/lib/auth/server";
import { extractNotionPageId } from "@/lib/knowledge/notion-page-id";
import { getSupabase } from "@/lib/platform/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const pageId = extractNotionPageId(new URL(req.url).searchParams.get("pageId") ?? "");
  if (!pageId) return Response.json({ error: "pageId 无效" }, { status: 400 });

  const [activeResponse, snapshotsResponse] = await Promise.all([
    getSupabase()
      .from("notion_pages")
      .select("page_id,page_title,page_url,last_synced_at,chunk_count,metadata")
      .eq("user_id", user.id)
      .eq("page_id", pageId)
      .maybeSingle(),
    getSupabase()
      .from("rag_index_snapshots")
      .select("id,index_version,page_payload,created_at")
      .eq("user_id", user.id)
      .eq("page_id", pageId)
      .order("created_at", { ascending: false }),
  ]);
  const error = activeResponse.error ?? snapshotsResponse.error;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({
    active: activeResponse.data,
    snapshots: snapshotsResponse.data ?? [],
  });
}
