import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ragEvalCases, type RagEvalCase } from "../lib/agent/eval/datasets/rag";
import { AGENTIC_RAG_VERSION } from "../lib/agent/rag/types";
import type {
  FusionStrategy,
  RAGSearchDebug,
  SearchResult,
} from "../lib/knowledge/retriever";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

type CliOptions = {
  limit: number;
  threshold: number;
  userId?: string;
  caseIds?: Set<string>;
  out?: string;
  json: boolean;
  enableMmr: boolean;
  enableRerank: boolean;
  enableQueryRewrite: boolean;
  enableMultiQueryVector: boolean;
  enableKeywordSearch: boolean;
  enableCrossEncoder: boolean;
  fusionStrategy: FusionStrategy;
  experiment: string;
  baseline?: string;
  maxRegression: number;
};

type RagCliConfig = {
  maxResults: number;
  fusionStrategy: FusionStrategy;
};

type CaseReport = {
  id: string;
  category?: RagEvalCase["category"];
  question: string;
  passed: boolean;
  sourceHit: boolean;
  sourceRank: number | null;
  relevanceMode: "explicit_source" | "keyword_proxy" | "not_evaluated";
  reciprocalRank: number;
  ndcgAtK: number;
  keywordCoverage: number;
  forbiddenHit: boolean;
  noResultExpected: boolean;
  noResultPassed: boolean | null;
  latencyMs: number;
  debug: RAGSearchDebug;
  topResults: Array<{
    rank: number;
    id: string;
    pageId: string;
    pageTitle: string;
    pageUrl: string;
    similarity: number;
    vectorScore: number;
    keywordScore: number;
    rrfScore?: number;
    crossEncoderScore?: number;
    rerankScore: number;
    retrievalSources: Array<"vector" | "keyword">;
    excerpt: string;
  }>;
  expected: {
    pageIds: string[];
    pageTitles: string[];
    urls: string[];
    keywords: string[];
    forbiddenKeywords: string[];
    minKeywordCoverage: number;
  };
};

function parseArgs(argv: string[], config: RagCliConfig): CliOptions {
  const options: CliOptions = {
    limit: 5,
    threshold: 0.5,
    userId: process.env.DEFAULT_USER_ID,
    json: false,
    enableMmr: true,
    enableRerank: true,
    enableQueryRewrite: true,
    enableMultiQueryVector: true,
    enableKeywordSearch: true,
    enableCrossEncoder: false,
    fusionStrategy: config.fusionStrategy,
    experiment: AGENTIC_RAG_VERSION,
    maxRegression: 0.02,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      options.limit = parseTopK(argv[++i], config.maxResults);
      continue;
    }
    if (arg === "--threshold") {
      options.threshold = parseScore(argv[++i], "--threshold");
      continue;
    }
    if (arg === "--user-id") {
      options.userId = argv[++i];
      continue;
    }
    if (arg === "--case") {
      const ids = argv[++i]?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
      options.caseIds = new Set(ids);
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
    if (arg === "--no-mmr") {
      options.enableMmr = false;
      continue;
    }
    if (arg === "--no-rerank") {
      options.enableRerank = false;
      continue;
    }
    if (arg === "--no-query-rewrite") {
      options.enableQueryRewrite = false;
      continue;
    }
    if (arg === "--no-multi-query-vector") {
      options.enableMultiQueryVector = false;
      continue;
    }
    if (arg === "--no-keyword") {
      options.enableKeywordSearch = false;
      continue;
    }
    if (arg === "--cross-encoder") {
      options.enableCrossEncoder = true;
      continue;
    }
    if (arg === "--fusion") {
      options.fusionStrategy = parseFusionStrategy(argv[++i]);
      continue;
    }
    if (arg === "--experiment") {
      options.experiment = argv[++i]?.trim() || AGENTIC_RAG_VERSION;
      continue;
    }
    if (arg === "--baseline") {
      options.baseline = argv[++i];
      continue;
    }
    if (arg === "--max-regression") {
      options.maxRegression = parseScore(argv[++i], "--max-regression");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.exit(0);
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function parsePositiveInteger(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是大于 0 的数字`);
  }
  return Math.floor(parsed);
}

function parseTopK(value: string | undefined, maxResults: number) {
  const parsed = parsePositiveInteger(value, "--limit");
  if (parsed > maxResults) {
    throw new Error(`--limit 不能超过全局硬上限 ${maxResults}`);
  }
  return parsed;
}

function parseFusionStrategy(value: string | undefined): FusionStrategy {
  if (value === "rrf" || value === "weighted") return value;
  throw new Error("--fusion 必须是 rrf 或 weighted");
}

function parseScore(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的数字`);
  }
  return parsed;
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesText(text: string, keyword: string) {
  return normalizeText(text).includes(normalizeText(keyword));
}

function compactExcerpt(text: string, maxChars = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function expectedPageIds(testCase: RagEvalCase) {
  return [...(testCase.expectedPageIds ?? []), testCase.expectedPageId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

function findSourceRank(testCase: RagEvalCase, results: SearchResult[]) {
  const pageIds = expectedPageIds(testCase);
  const pageTitles = testCase.expectedPageTitles ?? [];
  const urls = testCase.expectedUrls ?? [];

  const hasExplicitSource = pageIds.length > 0 || pageTitles.length > 0 || urls.length > 0;

  const index = results.findIndex((result) => {
    if (hasExplicitSource) {
      if (pageIds.includes(result.pageId)) return true;
      if (urls.some((url) => result.pageUrl.includes(url))) return true;
      return pageTitles.some((title) => includesText(result.pageTitle, title));
    }
    const expectedKeywords = testCase.expectedKeywords ?? [];
    if (expectedKeywords.length === 0) return false;
    const text = `${result.pageTitle}\n${result.content}`;
    const hits = expectedKeywords.filter((keyword) => includesText(text, keyword)).length;
    return hits / expectedKeywords.length >= (testCase.minKeywordCoverage ?? 0.67);
  });

  if (!hasExplicitSource && (testCase.expectedKeywords ?? []).length === 0) return null;
  return index >= 0 ? index + 1 : 0;
}

function scoreKeywordCoverage(testCase: RagEvalCase, results: SearchResult[]) {
  const expectedKeywords = testCase.expectedKeywords ?? [];
  if (expectedKeywords.length === 0) return 1;

  const joined = results.map((result) => `${result.pageTitle}\n${result.content}`).join("\n");
  const hits = expectedKeywords.filter((keyword) => includesText(joined, keyword)).length;
  return hits / expectedKeywords.length;
}

function hasForbiddenKeyword(testCase: RagEvalCase, results: SearchResult[]) {
  const forbiddenKeywords = testCase.forbiddenKeywords ?? [];
  if (forbiddenKeywords.length === 0) return false;

  const joined = results.map((result) => `${result.pageTitle}\n${result.content}`).join("\n");
  return forbiddenKeywords.some((keyword) => includesText(joined, keyword));
}

function evaluateCase(params: {
  testCase: RagEvalCase;
  results: SearchResult[];
  debug: RAGSearchDebug;
  latencyMs: number;
}): CaseReport {
  const { testCase, results, debug, latencyMs } = params;
  const sourceRank = findSourceRank(testCase, results);
  const relevanceMode = expectedPageIds(testCase).length > 0
    || (testCase.expectedPageTitles ?? []).length > 0
    || (testCase.expectedUrls ?? []).length > 0
      ? "explicit_source"
      : (testCase.expectedKeywords ?? []).length > 0
        ? "keyword_proxy"
        : "not_evaluated";
  const sourceHit = sourceRank === null ? true : sourceRank > 0;
  const keywordCoverage = scoreKeywordCoverage(testCase, results);
  const minKeywordCoverage = testCase.minKeywordCoverage ?? 0.67;
  const forbiddenHit = hasForbiddenKeyword(testCase, results);
  const noResultExpected = testCase.expectedNoResult === true;
  const noResultPassed = noResultExpected ? results.length === 0 : null;

  const passed = noResultExpected
    ? noResultPassed === true
    : sourceHit && keywordCoverage >= minKeywordCoverage && !forbiddenHit;

  return {
    id: testCase.id,
    category: testCase.category,
    question: testCase.question,
    passed,
    sourceHit,
    sourceRank,
    relevanceMode,
    reciprocalRank: sourceRank && sourceRank > 0 ? 1 / sourceRank : 0,
    ndcgAtK: sourceRank && sourceRank > 0 ? 1 / Math.log2(sourceRank + 1) : 0,
    keywordCoverage,
    forbiddenHit,
    noResultExpected,
    noResultPassed,
    latencyMs,
    debug,
    topResults: results.map((result, index) => ({
      rank: index + 1,
      id: result.id,
      pageId: result.pageId,
      pageTitle: result.pageTitle,
      pageUrl: result.pageUrl,
      similarity: result.similarity,
      vectorScore: result.vectorScore,
      keywordScore: result.keywordScore,
      rrfScore: result.rrfScore,
      crossEncoderScore: result.crossEncoderScore,
      rerankScore: result.rerankScore ?? result.combinedScore,
      retrievalSources: result.retrievalSources,
      excerpt: compactExcerpt(result.content),
    })),
    expected: {
      pageIds: expectedPageIds(testCase),
      pageTitles: testCase.expectedPageTitles ?? [],
      urls: testCase.expectedUrls ?? [],
      keywords: testCase.expectedKeywords ?? [],
      forbiddenKeywords: testCase.forbiddenKeywords ?? [],
      minKeywordCoverage,
    },
  };
}

function summarize(reports: CaseReport[]) {
  const retrievalReports = reports.filter((report) => !report.noResultExpected);
  const noResultReports = reports.filter((report) => report.noResultExpected);
  const sourceEvaluated = retrievalReports.filter((report) => report.sourceRank !== null);
  const sourceHits = sourceEvaluated.filter((report) => report.sourceHit).length;
  const noResultHits = noResultReports.filter((report) => report.noResultPassed).length;
  const totalLatencyMs = reports.reduce((sum, report) => sum + report.latencyMs, 0);

  return {
    cases: reports.length,
    passed: reports.filter((report) => report.passed).length,
    failed: reports.filter((report) => !report.passed).length,
    passRate: reports.length ? reports.filter((report) => report.passed).length / reports.length : 0,
    sourceEvaluated: sourceEvaluated.length,
    recallAtK: sourceEvaluated.length ? sourceHits / sourceEvaluated.length : null,
    mrr: sourceEvaluated.length
      ? sourceEvaluated.reduce((sum, report) => sum + report.reciprocalRank, 0) / sourceEvaluated.length
      : null,
    ndcgAtK: sourceEvaluated.length
      ? sourceEvaluated.reduce((sum, report) => sum + report.ndcgAtK, 0) / sourceEvaluated.length
      : null,
    avgKeywordCoverage: retrievalReports.length
      ? retrievalReports.reduce((sum, report) => sum + report.keywordCoverage, 0) / retrievalReports.length
      : null,
    noResultCases: noResultReports.length,
    noResultAccuracy: noResultReports.length ? noResultHits / noResultReports.length : null,
    avgLatencyMs: reports.length ? totalLatencyMs / reports.length : 0,
  };
}

function compareWithBaseline(
  current: ReturnType<typeof summarize>,
  baselinePath: string | undefined,
  maxRegression: number,
) {
  if (!baselinePath) return [];
  const absolutePath = path.resolve(baselinePath);
  const baseline = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as {
    summary?: Record<string, unknown>;
  };
  if (!baseline.summary) throw new Error(`baseline 缺少 summary: ${absolutePath}`);
  const metrics = [
    "passRate",
    "recallAtK",
    "mrr",
    "ndcgAtK",
    "noResultAccuracy",
  ] as const;
  return metrics.flatMap((metric) => {
    const currentValue = current[metric];
    const baselineValue = baseline.summary?.[metric];
    if (typeof currentValue !== "number" || typeof baselineValue !== "number") return [];
    const regression = baselineValue - currentValue;
    return regression > maxRegression
      ? [{ metric, current: currentValue, baseline: baselineValue, regression }]
      : [];
  });
}

async function main() {
  const [{ RAGRetriever }, { ragConfig }] = await Promise.all([
    import("../lib/knowledge/retriever"),
    import("../lib/platform/config"),
  ]);
  const options = parseArgs(process.argv.slice(2), ragConfig);
  const selectedCases = options.caseIds
    ? ragEvalCases.filter((testCase) => options.caseIds?.has(testCase.id))
    : ragEvalCases;

  if (selectedCases.length === 0) {
    throw new Error("没有匹配的 RAG eval case");
  }

  const retriever = new RAGRetriever();
  const reports: CaseReport[] = [];

  for (const testCase of selectedCases) {
    const startedAt = Date.now();
    const response = await retriever.searchWithDebug(testCase.question, {
      matchThreshold: options.threshold,
      matchCount: options.limit,
      userId: options.userId,
      enableMmr: options.enableMmr,
      enableQueryRewrite: options.enableQueryRewrite,
      enableMultiQueryVector: options.enableMultiQueryVector,
      enableRerank: options.enableRerank,
      enableKeywordSearch: options.enableKeywordSearch,
      enableCrossEncoder: options.enableCrossEncoder,
      fusionStrategy: options.fusionStrategy,
    });
    const report = evaluateCase({
      testCase,
      results: response.results,
      debug: response.debug,
      latencyMs: Date.now() - startedAt,
    });
    reports.push(report);
  }

  const summary = summarize(reports);
  const regressions = compareWithBaseline(
    summary,
    options.baseline,
    options.maxRegression,
  );
  const output = {
    generatedAt: new Date().toISOString(),
    experiment: options.experiment,
    strategyVersion: AGENTIC_RAG_VERSION,
    options: {
      limit: options.limit,
      threshold: options.threshold,
      userId: options.userId,
      enableMmr: options.enableMmr,
      enableRerank: options.enableRerank,
      enableQueryRewrite: options.enableQueryRewrite,
      enableMultiQueryVector: options.enableMultiQueryVector,
      enableKeywordSearch: options.enableKeywordSearch,
      enableCrossEncoder: options.enableCrossEncoder,
      fusionStrategy: options.fusionStrategy,
    },
    summary,
    regressions,
    reports,
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  if (summary.failed > 0 || regressions.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("RAG eval failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
