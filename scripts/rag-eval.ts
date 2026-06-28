import dotenv from "dotenv";
import { ragEvalCases } from "../lib/agent/eval/rag-cases";
import { RAGRetriever } from "../lib/server/retriever";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

function hasKeyword(text: string, keyword: string) {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

async function main() {
  const retriever = new RAGRetriever();
  let recallHits = 0;
  let reciprocalRankSum = 0;
  let keywordCoverageSum = 0;

  for (const testCase of ragEvalCases) {
    const response = await retriever.searchWithDebug(testCase.question, {
      matchThreshold: 0,
      matchCount: 5,
      enableMmr: true,
      enableQueryRewrite: true,
      enableRerank: true,
    });
    const results = response.results;
    const expectedPageId = testCase.expectedPageId;
    const rank = expectedPageId
      ? results.findIndex((result) => result.pageId === expectedPageId) + 1
      : results.length > 0
        ? 1
        : 0;
    const hit = rank > 0;
    if (hit) recallHits += 1;
    if (rank > 0) reciprocalRankSum += 1 / rank;

    const joined = results.map((result) => `${result.pageTitle}\n${result.content}`).join("\n");
    const expectedKeywords = testCase.expectedKeywords ?? [];
    const keywordHits = expectedKeywords.filter((keyword) => hasKeyword(joined, keyword)).length;
    const keywordCoverage = expectedKeywords.length > 0 ? keywordHits / expectedKeywords.length : 1;
    keywordCoverageSum += keywordCoverage;

    console.log(`\n[${testCase.id}] ${testCase.question}`);
    console.log(`  hit=${hit} rank=${rank || "-"} keywordCoverage=${keywordCoverage.toFixed(2)}`);
    console.log(`  rewrites=${response.debug.rewrittenQueries.join(" | ")}`);
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      console.log(
        `  ${index + 1}. ${result.pageTitle} sim=${result.similarity.toFixed(3)} rerank=${(result.rerankScore ?? result.combinedScore).toFixed(3)}`,
      );
    }
  }

  const total = ragEvalCases.length || 1;
  console.log("\n=== RAG Eval Summary ===");
  console.log(`cases=${ragEvalCases.length}`);
  console.log(`recall@5=${(recallHits / total).toFixed(3)}`);
  console.log(`mrr=${(reciprocalRankSum / total).toFixed(3)}`);
  console.log(`keywordCoverage=${(keywordCoverageSum / total).toFixed(3)}`);
}

main().catch((error) => {
  console.error("RAG eval failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
