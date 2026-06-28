import dotenv from "dotenv";
import { compileWiki } from "../lib/server/wiki-compiler";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

function printUsage() {
  console.error(
    [
      "用法: npm run wiki:compile [--force] [page_id ...]",
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
  const pageIds = args.filter((arg) => arg !== "--force");

  const results = await compileWiki({
    force,
    pageIds: pageIds.length > 0 ? pageIds : undefined,
    onEvent: (event) => {
      console.log(`[${event.type}] ${event.message}`);
    },
  });

  console.log(`\n编译完成：${results.length} 个结果`);
}

main().catch((error) => {
  console.error("Wiki 编译脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
