import dotenv from "dotenv";
import { cleanupMemoryHistory } from "../lib/agent/memory/history-cleanup";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

/**
 * 记忆历史表保留期清理（文档 4.5 / item 16）。范式对齐 artifacts:cleanup。
 *
 * 默认 **dry-run**，与 artifacts:cleanup 不同 —— 那边删的是可重新生成的产物，
 * 这边删的是不可恢复的用户历史。要真删必须显式加 --apply。
 */

function parseArgs(argv: string[]) {
  const options = { apply: false, json: false };
  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.exit(0);
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await cleanupMemoryHistory({ dryRun: !options.apply });

  if (options.json) {
    return;
  }

  console.table(
    result.tiers.map((tier) => ({
      类型: tier.memoryType,
      保留天数: tier.retentionDays,
      过期界线: tier.cutoff,
      [result.dryRun ? "将删除" : "已删除"]: tier.rows,
    })),
  );
}

main().catch((error) => {
  console.error(
    "Memory history cleanup failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
