import dotenv from "dotenv";
import { syncNotionPages } from "../lib/server/sync";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const pageIds = process.argv.slice(2);

  if (pageIds.length === 0) {
    console.error("用法: npm run rag:sync <notion_page_id> [...more_page_ids]");
    process.exit(1);
  }

  const results = await syncNotionPages(pageIds);

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
