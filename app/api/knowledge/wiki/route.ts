import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  try {
    const supabase = getSupabase();
    const { data: pages, error: pagesError } = await supabase
      .from("compiled_wiki_pages")
      .select("slug,title,summary,concepts,source_page_ids,updated_at,metadata")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(100);

    if (pagesError) throw pagesError;

    const { count: edgeCount, error: edgesError } = await supabase
      .from("compiled_wiki_edges")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (edgesError) throw edgesError;

    return Response.json(
      {
        pages: pages ?? [],
        edgeCount: edgeCount ?? 0,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "加载编译知识库失败" },
      { status: 500 },
    );
  }
}
