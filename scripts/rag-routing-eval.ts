import fs from "node:fs";
import path from "node:path";
import { buildRetrievalPlan } from "../lib/agent/rag/retrieval-router";
import { retrievalRoutingCases } from "../lib/agent/eval/retrieval-routing-cases";
import { summarizeRetrievalRouting } from "../lib/agent/eval/retrieval-routing";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function threshold(name: string, fallback: number) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的数字`);
  }
  return value;
}

const predictions = retrievalRoutingCases.map((testCase) => {
  const plan = buildRetrievalPlan({
    query: testCase.query,
    knowledgeProfile: testCase.knowledgeProfile,
    webEnabled: testCase.webEnabled,
  });
  return {
    ...testCase,
    predictedRoute: plan.route,
    reason: plan.reason,
  };
});
const summary = summarizeRetrievalRouting(predictions);
const output = {
  generatedAt: new Date().toISOString(),
  summary,
  predictions,
};
const out = option("--out");
if (out) {
  const outPath = path.resolve(out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));

const minAccuracy = threshold("--min-accuracy", 0.9);
const minPrecision = threshold("--min-retrieval-precision", 0.9);
const minRecall = threshold("--min-retrieval-recall", 0.9);
if (
  summary.accuracy < minAccuracy
  || summary.retrieval.precision < minPrecision
  || summary.retrieval.recall < minRecall
) {
  process.exitCode = 1;
}
