import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { GroundednessReport } from "../lib/agent/rag/types";
import { summarizeGroundednessReports } from "../lib/agent/eval/groundedness";
import { getSupabase } from "../lib/platform/supabase";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function scoreOption(name: string, fallback: number) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的数字`);
  }
  return value;
}

function reportsFromSteps(steps: unknown): GroundednessReport[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const value = step as Record<string, unknown>;
    return value.type === "answer_validation" && value.report
      ? [value.report as GroundednessReport]
      : [];
  });
}

async function loadReports() {
  const input = option("--input");
  if (input) {
    const data = JSON.parse(fs.readFileSync(path.resolve(input), "utf8")) as unknown;
    if (Array.isArray(data)) {
      return data.flatMap((item) =>
        item && typeof item === "object" && "steps" in item
          ? reportsFromSteps((item as { steps: unknown }).steps)
          : [item as GroundednessReport]);
    }
    throw new Error("--input 必须是 GroundednessReport[] 或含 steps 的 Trace[]");
  }

  const userId = option("--user-id") ?? process.env.DEFAULT_USER_ID;
  if (!userId) throw new Error("缺少 --user-id 或 DEFAULT_USER_ID");
  const limit = Math.min(Math.max(Number(option("--limit") ?? 200), 1), 1_000);
  const { data, error } = await getSupabase()
    .from("agent_traces")
    .select("steps")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`读取 Trace 失败: ${error.message}`);
  return (data ?? []).flatMap((row: { steps: unknown }) => reportsFromSteps(row.steps));
}

async function main() {
  const reports = await loadReports();
  if (reports.length === 0) throw new Error("没有可评估的 answer_validation Trace");
  const summary = summarizeGroundednessReports(reports);
  const output = { generatedAt: new Date().toISOString(), summary, reports };
  const out = option("--out");
  if (out) {
    const outPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  console.log(JSON.stringify(output, null, 2));
  if (
    summary.citationPrecision < scoreOption("--min-citation-precision", 0.8)
    || summary.groundedness < scoreOption("--min-groundedness", 0.75)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
