import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

type EvalCase = {
  id: string;
  query: string;
  expectedKeys: string[];
};

type EvalDataset = {
  cases: EvalCase[];
};

type CliOptions = {
  dataset?: string;
  userId?: string;
  out?: string;
  candidateCount: number;
  threshold?: number;
};

type ScoredCandidate = {
  caseId: string;
  query: string;
  key: string;
  content: string;
  score: number;
  relevant: boolean;
  vectorScore: number | null;
  keywordScore: number | null;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    candidateCount: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dataset") options.dataset = argv[++index];
    else if (arg === "--user-id") options.userId = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--candidate-count") options.candidateCount = Number(argv[++index]);
    else if (arg === "--vector-threshold") options.threshold = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "用法: npm run test:memory-rerank-threshold -- --dataset <json> --user-id <uuid> [选项]",
        "",
        "数据集格式: { \"cases\": [{ \"id\": \"diet-1\", \"query\": \"我讨厌吃什么\", \"expectedKeys\": [\"diet:food:折耳根\"] }] }",
        "选项: --candidate-count 12 --vector-threshold 0.68 --out artifacts/memory-rerank-eval.json",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (
    !Number.isFinite(options.candidateCount)
    || options.candidateCount < 2
    || options.candidateCount > 24
  ) {
    throw new Error("--candidate-count 必须在 2 到 24 之间");
  }
  if (
    options.threshold !== undefined
    && (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1)
  ) {
    throw new Error("--vector-threshold 必须在 0 到 1 之间");
  }
  return options;
}

function readDataset(file: string): EvalDataset {
  const payload = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as EvalDataset;
  if (!Array.isArray(payload.cases) || payload.cases.length === 0) {
    throw new Error("数据集必须包含非空 cases 数组");
  }
  for (const item of payload.cases) {
    if (!item.id || !item.query || !Array.isArray(item.expectedKeys)) {
      throw new Error("每条 case 都必须包含 id、query、expectedKeys");
    }
  }
  return payload;
}

function metricAtThreshold(
  threshold: number,
  candidates: ScoredCandidate[],
  missingRelevantCount: number,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = missingRelevantCount;
  for (const candidate of candidates) {
    const admitted = candidate.score >= threshold;
    if (admitted && candidate.relevant) truePositive += 1;
    else if (admitted) falsePositive += 1;
    else if (candidate.relevant) falseNegative += 1;
  }
  const precision = truePositive + falsePositive === 0
    ? 1
    : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0
    ? 1
    : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    threshold,
    precision,
    recall,
    f1,
    truePositive,
    falsePositive,
    falseNegative,
  };
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dataset) throw new Error("必须传 --dataset");
  if (!options.userId) throw new Error("必须传 --user-id，脚本不会把真实用户 ID 写进数据集");
  const { resolveUserMemoryConfig } = await import("../lib/memory-config/service");
  const userConfig = await resolveUserMemoryConfig(options.userId);
  if (!userConfig) throw new Error("该用户尚未保存记忆设置");
  if (!userConfig.rerank.configured) throw new Error("该用户尚未在记忆设置中配置 Rerank URL 和 API Key");
  const evalConfig = {
    ...userConfig,
    enabled: true,
    rerank: {
      ...userConfig.rerank,
      enabled: true,
      mode: "always" as const,
      candidateCount: Math.floor(options.candidateCount),
    },
  };
  const { recallRankedMemories } = await import("../lib/agent/memory/memory-flow");
  const dataset = readDataset(options.dataset);
  const candidates: ScoredCandidate[] = [];
  const missingRelevant: Array<{ caseId: string; key: string }> = [];

  for (const item of dataset.cases) {
    const result = await recallRankedMemories(item.query, {
      userId: options.userId,
      limit: Math.min(10, options.candidateCount),
      threshold: options.threshold,
      touch: false,
      config: evalConfig,
    });
    if (!result.rerankUsed) {
      throw new Error(`${item.id} 未获得 reranker 分数: ${result.rerankReason}`);
    }
    const scoredKeys = new Set<string>();
    for (const candidate of result.rerankTrace.candidates) {
      if (candidate.crossEncoderScore === null) continue;
      scoredKeys.add(candidate.key);
      candidates.push({
        caseId: item.id,
        query: item.query,
        key: candidate.key,
        content: candidate.content,
        score: candidate.crossEncoderScore,
        relevant: item.expectedKeys.includes(candidate.key),
        vectorScore: candidate.vectorScore,
        keywordScore: candidate.keywordScore,
      });
    }
    for (const key of item.expectedKeys) {
      if (!scoredKeys.has(key)) missingRelevant.push({ caseId: item.id, key });
    }
  }

  const thresholds = Array.from(new Set([
    0,
    1,
    ...candidates.map((candidate) => candidate.score),
  ])).sort((left, right) => left - right);
  const metrics = thresholds.map((threshold) =>
    metricAtThreshold(threshold, candidates, missingRelevant.length));
  const bestF1 = [...metrics].sort((left, right) =>
    right.f1 - left.f1
      || right.precision - left.precision
      || right.threshold - left.threshold)[0];
  const payload = {
    runAt: new Date().toISOString(),
    dataset: path.resolve(options.dataset),
    caseCount: dataset.cases.length,
    scoredCandidateCount: candidates.length,
    missingRelevant,
    bestF1,
    metrics,
    candidates,
  };

  console.table(
    [...metrics]
      .sort((left, right) => right.f1 - left.f1 || right.precision - left.precision)
      .slice(0, 12)
      .map((metric) => ({
        阈值: metric.threshold.toFixed(4),
        Precision: percent(metric.precision),
        Recall: percent(metric.recall),
        F1: metric.f1.toFixed(3),
        FP: metric.falsePositive,
        FN: metric.falseNegative,
      })),
  );
  console.log(`best F1 threshold: ${bestF1?.threshold ?? "n/a"}`);
  console.log(`未进入 rerank 候选池的相关 key: ${missingRelevant.length}`);

  if (options.out) {
    const target = path.resolve(options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  }
}

main().catch((error) => {
  console.error("记忆 reranker 阈值评估失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
