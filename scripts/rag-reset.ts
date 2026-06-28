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

function printUsage() {
  console.log(
    [
      "用法:",
      "  npm run rag:reset              # 预览将删除的 RAG 页面和 chunk",
      "  npm run rag:reset -- --confirm # 确认删除所有 RAG 页面和 chunk",
      "  npm run rag:reset -- --user-id <uuid> --confirm # 只删除某个用户的 RAG 数据",
      "",
      "说明:",
      "  只清理 notion_pages 和 documents 两张 RAG 表。",
      "  documents 通过外键 ON DELETE CASCADE 跟随 notion_pages 删除。",
      "  不会删除 agent_semantic_memories 等其它记忆表。",
    ].join("\n"),
  );
}

function formatPage(page: RagPage) {
  const syncedAt = page.last_synced_at ?? "unknown";
  const chunkCount = page.chunk_count ?? 0;
  const owner = page.user_id ? ` user=${page.user_id}` : "";
  return `- ${page.page_title} (${page.page_id}) chunks=${chunkCount} synced=${syncedAt}${owner}`;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const userId = args.includes("--user-id")
    ? args[args.indexOf("--user-id") + 1]
    : process.env.DEFAULT_USER_ID;

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
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
  const totalChunks = ragPages.reduce((sum, page) => sum + (page.chunk_count ?? 0), 0);

  console.log(`将清理 RAG 页面: ${ragPages.length} 个`);
  console.log(`将清理 RAG chunks: ${totalChunks} 个`);

  if (ragPages.length > 0) {
    console.log("");
    for (const page of ragPages) {
      console.log(formatPage(page));
    }
  }

  if (ragPages.length === 0) {
    console.log("\n没有可清理的 RAG 数据。");
    return;
  }

  if (!confirm) {
    console.log("");
    console.log("当前是 dry run，没有删除任何数据。");
    console.log("确认删除请执行: npm run rag:reset -- --confirm");
    return;
  }

  console.log("");
  console.log("开始删除 RAG 数据...");

  for (const page of ragPages) {
    const { error: deleteError } = await supabase
      .from("notion_pages")
      .delete()
      .eq("id", page.id);

    if (deleteError) {
      throw new Error(`删除页面 ${page.page_id} 失败: ${deleteError.message}`);
    }
  }

  console.log(`删除完成: ${ragPages.length} 个页面，约 ${totalChunks} 个 chunk`);
}

main().catch((error) => {
  console.error("RAG 重置脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
