import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { memoryIntegrationCases } from "../lib/agent/eval/datasets/memory";
import type { MemoryFusionStrategy } from "../lib/agent/memory/fusion";
import { recallRankedMemories } from "../lib/agent/memory/memory-flow";
import { purgeMemoryKey } from "../lib/agent/memory/atomic-writer";
import { SemanticStore } from "../lib/agent/memory/semantic-store";
import { hasSupabaseConfig } from "../lib/platform/supabase";
import type { MemoryExecutionConfig } from "../lib/memory-config/types";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

/**
 * 融合策略三方对照跑分器（文档 5.5 / item 13）。
 *
 * 存在的唯一理由：**赢家用数据定，不用推理定**。weighted 是当前默认值，但那是
 * 「候选池小、分数量级携带信息」这条推理的产物；不跑 vector_only 对照组，
 * 「融合有效」这个结论无法证伪。若 weighted / rrf 相对 vector_only 的增量小于
 * 噪声，5.5 整节都不该留下。
 *
 * 量的是什么、不量什么，说清楚免得误读：
 *   - 量：检索层的 hit@1 / hit@3 / MRR。直接调 recallRankedMemories。
 *   - 不量：入口正则（shouldRecall）。它是纯函数，由 recall_gate 那组 case 覆盖。
 *     所以这里的「负例」考的是「检索层在无关查询上是否安然返回空」，
 *     不是「无关查询是否会触发召回」。
 *
 * 负例必须留在集合里：关键词通道天然倾向多召回，只看正例一定得出「全面变好」，
 * 而代价（噪声）恰好落在负例上。
 *
 * 需要真实 Supabase + embedding 服务，会**真的写入并硬删除** --user-id 名下的记忆，
 * 所以默认拒绝在没有显式 --user-id 时运行。
 */

const STRATEGIES: MemoryFusionStrategy[] = ["vector_only", "weighted", "rrf"];

type AbCase = {
  id: string;
  seed: Array<{ key: string; content: string }>;
  query: string;
  expectedKeys: string[];
  expectation: "pass" | "known_red";
};

type CaseResult = {
  id: string;
  query: string;
  expectedKeys: string[];
  expectation: "pass" | "known_red";
  /** 召回到的 key，按融合分降序。 */
  gotKeys: string[];
  hitAt1: boolean;
  hitAt3: boolean;
  /** 1 / 命中排名；未命中为 0。负例（expectedKeys 为空）不计入。 */
  reciprocalRank: number;
  vectorCount: number;
  keywordCount: number;
  candidateCount: number;
  latencyMs: number;
  passed: boolean;
};

type StrategyReport = {
  strategy: MemoryFusionStrategy;
  positiveCases: number;
  negativeCases: number;
  hitAt1: number;
  hitAt3: number;
  mrr: number;
  /** 负例上正确返回空的比例。 */
  negativeCleanRate: number;
  cases: CaseResult[];
};

type CliOptions = {
  userId?: string;
  limit: number;
  threshold?: number;
  out?: string;
  json: boolean;
  keepSeeds: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { limit: 3, json: false, keepSeeds: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-id") {
      options.userId = argv[++i];
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit 必须大于 0");
      options.limit = Math.floor(parsed);
      continue;
    }
    if (arg === "--threshold") {
      const parsed = Number(argv[++i]);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error("--threshold 必须在 0 到 1 之间");
      }
      options.threshold = parsed;
      continue;
    }
    if (arg === "--out") {
      options.out = argv[++i];
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--keep-seeds") {
      options.keepSeeds = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.exit(0);
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

/** 只有单轮提问型 case 能进 A/B；多步 probe 的 case 显式列出跳过原因。 */
function collectAbCases(): { cases: AbCase[]; skipped: string[] } {
  const cases: AbCase[] = [];
  const skipped: string[] = [];
  for (const testCase of memoryIntegrationCases) {
    if (testCase.kind !== "retrieval_quality") continue;
    if (!testCase.ab) {
      skipped.push(`${testCase.id}（probe 不是单轮提问：${testCase.probe}）`);
      continue;
    }
    cases.push({
      id: testCase.id,
      seed: testCase.seed,
      query: testCase.ab.query,
      expectedKeys: testCase.ab.expectedKeys,
      expectation: testCase.expectation,
    });
  }
  return { cases, skipped };
}

async function seed(store: SemanticStore, entries: AbCase["seed"], userId: string) {
  for (const entry of entries) {
    // 先硬删再写：上一次跑分残留的同 key 记忆会带着旧 content 参与召回。
    await purgeMemoryKey(entry.key, userId);
    await store.set(
      entry.key,
      entry.content,
      { type: "fact", source: "user_explicit", confidence: 0.9, importance: 0.7 },
      { userId },
    );
  }
}

async function cleanup(entries: AbCase["seed"], userId: string) {
  for (const entry of entries) {
    await purgeMemoryKey(entry.key, userId);
  }
}

function scoreCase(abCase: AbCase, gotKeys: string[]): Pick<
  CaseResult,
  "hitAt1" | "hitAt3" | "reciprocalRank" | "passed"
> {
  // 负例：召回任何东西都算不过。
  if (abCase.expectedKeys.length === 0) {
    const clean = gotKeys.length === 0;
    return { hitAt1: clean, hitAt3: clean, reciprocalRank: 0, passed: clean };
  }
  const rank = gotKeys.findIndex((key) => abCase.expectedKeys.includes(key)) + 1;
  const hitAt1 = rank === 1;
  const hitAt3 = rank > 0 && rank <= 3;
  return {
    hitAt1,
    hitAt3,
    reciprocalRank: rank > 0 ? 1 / rank : 0,
    // 判定口径是 hit@1：记忆只有 top-3 会进 prompt，且模型倾向采信第一条。
    passed: hitAt1,
  };
}

async function runStrategy(
  strategy: MemoryFusionStrategy,
  abCases: AbCase[],
  store: SemanticStore,
  options: CliOptions & { userId: string; config: MemoryExecutionConfig },
): Promise<StrategyReport> {
  const cases: CaseResult[] = [];

  for (const abCase of abCases) {
    // 每条 case 独立种子 + 独立清理：多条 case 共用 budget:car 这类 key，
    // 混在一起跑会让某条 case 的种子变成另一条的干扰项，结果不可复现。
    await seed(store, abCase.seed, options.userId);
    const startedAt = Date.now();
    const recall = await recallRankedMemories(abCase.query, {
      limit: options.limit,
      threshold: options.threshold,
      userId: options.userId,
      strategy,
      config: options.config,
    });
    const latencyMs = Date.now() - startedAt;
    if (!options.keepSeeds) await cleanup(abCase.seed, options.userId);

    const gotKeys = recall.selected.map((record) => record.key);
    cases.push({
      id: abCase.id,
      query: abCase.query,
      expectedKeys: abCase.expectedKeys,
      expectation: abCase.expectation,
      gotKeys,
      vectorCount: recall.vectorCount,
      keywordCount: recall.keywordCount,
      candidateCount: recall.candidates.length,
      latencyMs,
      ...scoreCase(abCase, gotKeys),
    });
  }

  const positives = cases.filter((result) => result.expectedKeys.length > 0);
  const negatives = cases.filter((result) => result.expectedKeys.length === 0);
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    strategy,
    positiveCases: positives.length,
    negativeCases: negatives.length,
    hitAt1: mean(positives.map((result) => (result.hitAt1 ? 1 : 0))),
    hitAt3: mean(positives.map((result) => (result.hitAt3 ? 1 : 0))),
    mrr: mean(positives.map((result) => result.reciprocalRank)),
    negativeCleanRate: mean(negatives.map((result) => (result.passed ? 1 : 0))),
    cases,
  };
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function printReport(reports: StrategyReport[]) {
  console.table(
    reports.map((report) => ({
      策略: report.strategy,
      "hit@1": percent(report.hitAt1),
      "hit@3": percent(report.hitAt3),
      MRR: report.mrr.toFixed(3),
      负例干净率: percent(report.negativeCleanRate),
      正例数: report.positiveCases,
      负例数: report.negativeCases,
    })),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!hasSupabaseConfig()) throw new Error("缺少 Supabase 配置，无法跑真实检索链路");
  if (!options.userId) {
    throw new Error(
      "必须显式传 --user-id：脚本会硬删除该用户名下的种子 key，"
      + "不设默认值以免误删真实用户的记忆",
    );
  }

  const { cases, skipped } = collectAbCases();
  if (cases.length === 0) throw new Error("没有可跑的 A/B case");

  const store = new SemanticStore();
  const { resolveUserMemoryConfig } = await import("../lib/memory-config/service");
  const savedConfig = await resolveUserMemoryConfig(options.userId);
  if (!savedConfig) throw new Error("该用户尚未保存记忆设置");
  const evalConfig: MemoryExecutionConfig = {
    ...savedConfig,
    enabled: true,
    rerank: { ...savedConfig.rerank, enabled: false },
  };
  const reports: StrategyReport[] = [];
  for (const strategy of STRATEGIES) {
    reports.push(
      await runStrategy(strategy, cases, store, { ...options, userId: options.userId, config: evalConfig }),
    );
  }

  const payload = { runAt: new Date().toISOString(), options, reports, skipped };
  if (!options.json) printReport(reports);
  if (options.out) {
    const target = path.resolve(options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  }
}

main().catch((error) => {
  console.error("融合对照跑分失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
