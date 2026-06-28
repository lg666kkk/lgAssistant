import dotenv from "dotenv";
import { RAGRetriever } from "../lib/server/retriever";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.5;

type CliOptions = {
  query: string;
  limit: number;
  threshold: number;
};

function printUsage() {
  console.error(
    [
      '用法: npm run rag:search "query" [--limit 5] [--threshold 0.5]',
      "",
      "示例:",
      '  npm run rag:search "怎么做 RAG 检索优化"',
      '  npm run rag:search "Notion 同步流程" -- --limit 10 --threshold 0.3',
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  const queryParts: string[] = [];
  let limit = DEFAULT_LIMIT;
  let threshold = DEFAULT_THRESHOLD;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit 必须是大于 0 的数字");
      }
      limit = Math.floor(value);
      continue;
    }

    if (arg === "--threshold") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error("--threshold 必须是 0 到 1 之间的数字");
      }
      threshold = value;
      continue;
    }

    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) return null;

  return { query, limit, threshold };
}

function compactExcerpt(text: string, maxChars = 220) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options) {
    printUsage();
    process.exit(1);
  }

  const retriever = new RAGRetriever();
  const results = await retriever.search(options.query, {
    matchThreshold: options.threshold,
    matchCount: options.limit,
  });

  console.log(`查询: ${options.query}`);
  console.log(`阈值: ${options.threshold}`);
  console.log(`数量: ${options.limit}`);
  console.log("");

  if (results.length === 0) {
    console.log("没有找到相关笔记");
    return;
  }

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    console.log(`#${index + 1} ${result.pageTitle}`);
    console.log(`相似度: ${result.similarity.toFixed(3)}`);
    console.log(`链接: ${result.pageUrl}`);
    console.log(`Page ID: ${result.pageId}`);
    console.log(`摘录: ${compactExcerpt(result.content)}`);
    console.log("");
  }
}

main().catch((error) => {
  console.error("RAG 检索脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
