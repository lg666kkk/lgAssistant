import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data: pages, error: pagesError } = await supabase
      .from("compiled_wiki_pages")
      .select("slug,title,summary,concepts,source_page_ids,updated_at,metadata")
      .order("updated_at", { ascending: false })
      .limit(100);

    if (pagesError) throw pagesError;

    const { count: edgeCount, error: edgesError } = await supabase
      .from("compiled_wiki_edges")
      .select("id", { count: "exact", head: true });

    if (edgesError) throw edgesError;

    return Response.json({
      pages: pages ?? [],
      edgeCount: edgeCount ?? 0,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "加载编译知识库失败" },
      { status: 500 },
    );
  }
}
