import dotenv from "dotenv";
import { compileWiki } from "../lib/knowledge/wiki-compiler";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

function printUsage() {
  console.error(
    [
      "用法: npm run wiki:compile -- --user-id <uuid> [--force] [page_id ...]",
      "",
      "说明:",
      "  不传 page_id 时会编译所有已同步的 Notion 页面。",
      "  --force 会忽略 content_hash，强制重新编译。",
    ].join("\n"),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const force = args.includes("--force");
  const userIdIndex = args.indexOf("--user-id");
  const userId = userIdIndex >= 0 ? args[userIdIndex + 1] : undefined;
  if (!userId) throw new Error("缺少 --user-id，无法选择用户模型配置");
  const pageIds = args.filter((arg, index) =>
    arg !== "--force" && arg !== "--user-id" && index !== userIdIndex + 1);

  await compileWiki({
    userId,
    force,
    pageIds: pageIds.length > 0 ? pageIds : undefined,
  });
}

main().catch((error) => {
  console.error("Wiki 编译脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
