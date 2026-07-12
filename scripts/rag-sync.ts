import dotenv from "dotenv";
import { syncNotionPageTree, syncNotionPages } from "../lib/knowledge/sync";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const syncTree = args.includes("--tree");
  const force = args.includes("--force");
  const userId = args.includes("--user-id")
    ? args[args.indexOf("--user-id") + 1]
    : process.env.DEFAULT_USER_ID;
  const pageIds = args.filter((arg, index) => {
    if (arg === "--tree" || arg === "--force" || arg === "--user-id") return false;
    if (args[index - 1] === "--user-id") return false;
    return true;
  });

  if (pageIds.length === 0) {
    console.error("用法: npm run rag:sync [--tree] [--force] [--user-id <uuid>] <notion_page_id> [...more_page_ids]");
    console.error("示例: npm run rag:sync -- --tree --force bfddfbc3bf344913a2aa92bbccc72524");
    process.exit(1);
  }

  const results = syncTree
    ? (await Promise.all(pageIds.map((pageId) => syncNotionPageTree(pageId, { force, userId })))).flat()
    : await syncNotionPages(pageIds, { force, userId });

  const failed = results.filter((item) => !item.success);

  if (failed.length > 0) {
    console.error("\n同步失败页面:");
    for (const item of failed) {
      console.error(`- ${item.pageId}: ${item.error}`);
    }
    process.exit(1);
  }

  console.log("\n所有页面同步成功");
}

main().catch((error) => {
  console.error("RAG 同步脚本异常:", error);
  process.exit(1);
});
