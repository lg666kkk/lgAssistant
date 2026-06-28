import { createClient } from "@supabase/supabase-js";
import ws from "ws";

function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("缺少 Supabase 环境变量");
  }

  return createClient(supabaseUrl, supabaseKey, {
    realtime: {
      transport: ws as any,
    },
  });
}

export async function GET() {
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from("notion_pages")
      .select("page_id,page_title,page_url,last_edited_time,last_synced_at,chunk_count,metadata")
      .order("last_synced_at", { ascending: false });

    if (error) {
      throw error;
    }

    return Response.json(
      { pages: data ?? [] },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "加载知识库失败" },
      { status: 500 },
    );
  }
}
