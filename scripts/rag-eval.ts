import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ragEvalCases, type RagEvalCase } from "../lib/agent/eval/rag-cases";
import { RAGRetriever, type RAGSearchDebug, type SearchResult } from "../lib/server/retriever";

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
  enableKeywordSearch: boolean;
};

type CaseReport = {
  id: string;
  category?: RagEvalCase["category"];
  question: string;
  passed: boolean;
  sourceHit: boolean;
  sourceRank: number | null;
  reciprocalRank: number;
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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 5,
    threshold: 0.5,
    userId: process.env.DEFAULT_USER_ID,
    json: false,
    enableMmr: true,
    enableRerank: true,
    enableQueryRewrite: true,
    enableKeywordSearch: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      options.limit = parsePositiveInteger(argv[++i], "--limit");
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
    if (arg === "--no-keyword") {
      options.enableKeywordSearch = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
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

function parseScore(value: string | undefined, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的数字`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    [
      "用法: npm run test:rag -- [options]",
      "",
      "Options:",
      "  --limit 5               每个 case 返回 top K，默认 5",
      "  --threshold 0.5         向量相似度阈值，默认 0.5",
      "  --user-id <uuid>        指定用户知识库；默认 DEFAULT_USER_ID",
      "  --case id1,id2          只跑指定 case",
      "  --out <path>            写 JSON 报告",
      "  --json                  在 stdout 输出 JSON",
      "  --no-mmr                关闭 MMR",
      "  --no-rerank             关闭规则 rerank",
      "  --no-query-rewrite      关闭 query rewrite",
      "  --no-keyword            关闭 keyword search",
    ].join("\n"),
  );
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

  if (pageIds.length === 0 && pageTitles.length === 0 && urls.length === 0) {
    return null;
  }

  const index = results.findIndex((result) => {
    if (pageIds.includes(result.pageId)) return true;
    if (urls.some((url) => result.pageUrl.includes(url))) return true;
    return pageTitles.some((title) => includesText(result.pageTitle, title));
  });

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
    reciprocalRank: sourceRank && sourceRank > 0 ? 1 / sourceRank : 0,
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
    avgKeywordCoverage: retrievalReports.length
      ? retrievalReports.reduce((sum, report) => sum + report.keywordCoverage, 0) / retrievalReports.length
      : null,
    noResultCases: noResultReports.length,
    noResultAccuracy: noResultReports.length ? noResultHits / noResultReports.length : null,
    avgLatencyMs: reports.length ? totalLatencyMs / reports.length : 0,
  };
}

function printCaseReport(report: CaseReport) {
  const status = report.passed ? "PASS" : "FAIL";
  const sourceRank = report.sourceRank === null ? "n/a" : report.sourceRank || "-";
  const noResult = report.noResultExpected
    ? ` noResult=${report.noResultPassed ? "ok" : "miss"}`
    : "";

  console.log(`\n[${status}] ${report.id} ${report.category ? `(${report.category})` : ""}`);
  console.log(`  Q: ${report.question}`);
  console.log(
    `  sourceRank=${sourceRank} keywordCoverage=${report.keywordCoverage.toFixed(2)} latency=${report.latencyMs}ms${noResult}`,
  );
  if (report.debug.rewrittenQueries.length > 1) {
    console.log(`  rewrites=${report.debug.rewrittenQueries.join(" | ")}`);
  }
  console.log(
    `  candidates vector=${report.debug.vectorCandidateCount} keyword=${report.debug.keywordCandidateCount} merged=${report.debug.mergedCandidateCount}`,
  );
  for (const result of report.topResults.slice(0, 5)) {
    console.log(
      `  ${result.rank}. ${result.pageTitle} score=${result.rerankScore.toFixed(3)} vector=${result.vectorScore.toFixed(3)} keyword=${result.keywordScore.toFixed(3)} source=${result.retrievalSources.join("+")}`,
    );
    console.log(`     ${result.excerpt}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
      enableRerank: options.enableRerank,
      enableKeywordSearch: options.enableKeywordSearch,
    });
    const report = evaluateCase({
      testCase,
      results: response.results,
      debug: response.debug,
      latencyMs: Date.now() - startedAt,
    });
    reports.push(report);
    if (!options.json) {
      printCaseReport(report);
    }
  }

  const summary = summarize(reports);
  const output = {
    generatedAt: new Date().toISOString(),
    options: {
      limit: options.limit,
      threshold: options.threshold,
      userId: options.userId,
      enableMmr: options.enableMmr,
      enableRerank: options.enableRerank,
      enableQueryRewrite: options.enableQueryRewrite,
      enableKeywordSearch: options.enableKeywordSearch,
    },
    summary,
    reports,
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("\n=== RAG Eval Summary ===");
    console.log(`cases=${summary.cases} passed=${summary.passed} failed=${summary.failed}`);
    console.log(`passRate=${summary.passRate.toFixed(3)}`);
    console.log(
      `recall@${options.limit}=${summary.recallAtK === null ? "n/a" : summary.recallAtK.toFixed(3)}`,
    );
    console.log(`mrr=${summary.mrr === null ? "n/a" : summary.mrr.toFixed(3)}`);
    console.log(
      `keywordCoverage=${summary.avgKeywordCoverage === null ? "n/a" : summary.avgKeywordCoverage.toFixed(3)}`,
    );
    console.log(
      `noResultAccuracy=${summary.noResultAccuracy === null ? "n/a" : summary.noResultAccuracy.toFixed(3)}`,
    );
    console.log(`avgLatencyMs=${Math.round(summary.avgLatencyMs)}`);
    if (options.out) {
      console.log(`report=${path.resolve(options.out)}`);
    }
  }

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("RAG eval failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
