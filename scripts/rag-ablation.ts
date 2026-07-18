import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AGENTIC_RAG_VERSION } from "../lib/agent/rag/types";

const variants = [
  { name: "full", flags: [] },
  { name: "no-query-rewrite", flags: ["--no-query-rewrite"] },
  { name: "no-keyword", flags: ["--no-keyword"] },
  { name: "no-rerank", flags: ["--no-rerank"] },
  { name: "no-mmr", flags: ["--no-mmr"] },
] as const;

function stripManagedArgs(args: string[]) {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["--out", "--experiment", "--baseline"].includes(args[index])) {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve("reports/rag-eval", `${AGENTIC_RAG_VERSION}-${runId}`);
fs.mkdirSync(outputDir, { recursive: true });
const commonArgs = stripManagedArgs(process.argv.slice(2));
const runs: Array<{ name: string; report: string; exitCode: number }> = [];

for (const variant of variants) {
  const report = path.join(outputDir, `${variant.name}.json`);
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    path.resolve("scripts/rag-eval.ts"),
    ...commonArgs,
    ...variant.flags,
    "--experiment",
    `${AGENTIC_RAG_VERSION}:${variant.name}`,
    "--out",
    report,
    "--json",
  ], { stdio: "inherit" });
  runs.push({
    name: variant.name,
    report,
    exitCode: result.status ?? 1,
  });
}

const manifest = {
  runId,
  strategyVersion: AGENTIC_RAG_VERSION,
  generatedAt: new Date().toISOString(),
  runs,
};
fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Ablation reports: ${outputDir}`);
if (runs.some((run) => run.exitCode !== 0)) process.exitCode = 1;
