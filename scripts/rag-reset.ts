import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

type RagPage = {
  id: string;
  user_id: string | null;
  page_id: string;
  page_title: string;
  chunk_count: number | null;
  last_synced_at: string | null;
};

function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("缺少 Supabase 环境变量 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    realtime: {
      transport: ws as any,
    },
  });
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const userId = args.includes("--user-id")
    ? args[args.indexOf("--user-id") + 1]
    : process.env.DEFAULT_USER_ID;

  if (args.includes("--help") || args.includes("-h")) {
    return;
  }

  const supabase = createSupabaseClient();

  let pagesQuery = supabase
    .from("notion_pages")
    .select("id,user_id,page_id,page_title,chunk_count,last_synced_at")
    .order("last_synced_at", { ascending: false });

  if (userId) {
    pagesQuery = pagesQuery.eq("user_id", userId);
  }

  const { data: pages, error } = await pagesQuery;

  if (error) {
    throw new Error(`读取 RAG 页面失败: ${error.message}`);
  }

  const ragPages = (pages ?? []) as RagPage[];

  if (ragPages.length === 0) {
    return;
  }

  if (!confirm) {
    return;
  }
  for (const page of ragPages) {
    const { error: deleteError } = await supabase
      .from("notion_pages")
      .delete()
      .eq("id", page.id);

    if (deleteError) {
      throw new Error(`删除页面 ${page.page_id} 失败: ${deleteError.message}`);
    }
  }
}

main().catch((error) => {
  console.error("RAG 重置脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
