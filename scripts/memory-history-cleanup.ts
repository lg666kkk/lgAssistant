import dotenv from "dotenv";
import {
  cleanupMemoryHistory,
  resolveRetentionTiers,
} from "../lib/agent/memory/history-cleanup";

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
      console.log(`用法: tsx scripts/memory-history-cleanup.ts [--apply] [--json]

  （默认）        只统计将被删除的行数，不做任何删除。
  --apply        真的删除。历史行删掉不可恢复。
  --json         输出 JSON。

  分档保留天数可用环境变量覆盖（单位：天，必须 > 0）：
    MEMORY_HISTORY_RETENTION_DAYS_PROFILE / _CORRECTION / _FACT
    MEMORY_HISTORY_RETENTION_DAYS_PREFERENCE / _PROJECT / _EPISODIC / _DEFAULT
`);
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
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    result.dryRun
      ? "Memory history cleanup (dry-run，未删除任何行；加 --apply 才真删)"
      : "Memory history cleanup complete",
  );
  console.table(
    result.tiers.map((tier) => ({
      类型: tier.memoryType,
      保留天数: tier.retentionDays,
      过期界线: tier.cutoff,
      [result.dryRun ? "将删除" : "已删除"]: tier.rows,
    })),
  );
  console.log(
    [
      `tiers=${result.scannedTiers}`,
      `${result.dryRun ? "wouldDelete" : "deleted"}=${result.deletedRows}`,
      `remaining=${result.remainingRows ?? "unknown"}`,
    ].join(" "),
  );
  if (result.dryRun && result.deletedRows > 0) {
    console.log("\n确认无误后重跑：npm run memory:history:cleanup -- --apply");
  }
}

main().catch((error) => {
  console.error(
    "Memory history cleanup failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
