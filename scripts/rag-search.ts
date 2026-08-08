import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

type CliOptions = {
  query: string;
  limit: number;
  threshold: number;
  userId?: string;
};

type RagCliConfig = {
  maxResults: number;
  similarityThreshold: number;
};

function printUsage(config: RagCliConfig) {
  console.error(
    [
      '用法: npm run rag:search "query" [--limit 5] [--threshold 0.5] [--user-id <uuid>]',
      "",
      "示例:",
      '  npm run rag:search "怎么做 RAG 检索优化"',
      `  npm run rag:search "Notion 同步流程" -- --limit ${config.maxResults} --threshold 0.4`,
    ].join("\n"),
  );
}

function parseArgs(argv: string[], config: RagCliConfig): CliOptions | null {
  const queryParts: string[] = [];
  let limit = config.maxResults;
  let threshold = config.similarityThreshold;
  let userId = process.env.DEFAULT_USER_ID;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > config.maxResults) {
        throw new Error(`--limit 必须是 1 到 ${config.maxResults} 之间的数字`);
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

    if (arg === "--user-id") {
      userId = argv[++i];
      continue;
    }

    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) return null;

  return { query, limit, threshold, userId };
}

async function main() {
  const [{ RAGRetriever }, { ragConfig }] = await Promise.all([
    import("../lib/knowledge/retriever"),
    import("../lib/platform/config"),
  ]);
  const options = parseArgs(process.argv.slice(2), ragConfig);

  if (!options) {
    printUsage(ragConfig);
    process.exit(1);
  }

  const retriever = new RAGRetriever();
  await retriever.searchWithDebug(options.query, {
    matchThreshold: options.threshold,
    matchCount: options.limit,
    userId: options.userId,
    enableQueryRewrite: true,
    enableMmr: true,
    enableRerank: true,
  });
}

main().catch((error) => {
  console.error("RAG 检索脚本异常:", error instanceof Error ? error.message : error);
  process.exit(1);
});
