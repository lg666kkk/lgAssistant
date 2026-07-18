import dotenv from "dotenv";
import { Langfuse } from "langfuse";
import type { EvalCase } from "../lib/agent/eval/cases";
import type { EvalRunResult } from "../lib/agent/eval/runner";
import {
  buildLangfuseEvalCases,
  isLangfuseEvalInput,
  LANGFUSE_EVAL_DATASET,
  type LangfuseEvalInput,
} from "../lib/agent/eval/langfuse-dataset";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

type CliOptions = {
  sync: boolean;
  run: boolean;
  live: boolean;
  dataset: string;
  runName: string;
  kind?: LangfuseEvalInput["kind"];
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sync: false,
    run: false,
    live: false,
    dataset: LANGFUSE_EVAL_DATASET,
    runName: `agent-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sync") options.sync = true;
    else if (arg === "--run") options.run = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--dataset") options.dataset = argv[++index] ?? options.dataset;
    else if (arg === "--run-name") options.runName = argv[++index] ?? options.runName;
    else if (arg === "--kind") {
      const kind = argv[++index];
      if (kind !== "agent" && kind !== "routing") throw new Error("--kind 必须是 agent 或 routing");
      options.kind = kind;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "用法:",
        "  npm run eval:langfuse -- --sync",
        "  npm run eval:langfuse -- --run --kind routing",
        "  npm run eval:langfuse -- --run --kind agent --live",
        "",
        "--sync                 同步本地 case 到 Langfuse Dataset",
        "--run                  创建并执行一次 Dataset Run",
        "--live                 允许 agent 用例调用真实模型",
        "--kind agent|routing   只执行一种用例",
        "--run-name <name>      指定 Langfuse Dataset Run 名称",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!options.sync && !options.run) options.sync = true;
  return options;
}

function createLangfuse() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) throw new Error("缺少 LANGFUSE_PUBLIC_KEY 或 LANGFUSE_SECRET_KEY");
  return new Langfuse({ publicKey, secretKey, baseUrl: process.env.LANGFUSE_BASE_URL });
}

async function syncDataset(langfuse: Langfuse, datasetName: string) {
  await langfuse.createDataset({
    name: datasetName,
    description: "Personal Assistant 的工具调用与检索路由回归用例。",
    metadata: { schemaVersion: "v1", managedBy: "scripts/langfuse-eval.ts" },
  });

  const cases = buildLangfuseEvalCases();
  for (const testCase of cases) {
    await langfuse.createDatasetItem({
      id: testCase.id,
      datasetName,
      input: testCase.input,
      expectedOutput: testCase.expectedOutput,
      metadata: testCase.metadata,
      status: "ACTIVE",
    });
  }
  console.log(JSON.stringify({ dataset: datasetName, synced: cases.length }, null, 2));
}

function agentChecks(result: EvalRunResult, expected: EvalCase["expect"]) {
  const hasTool = (toolName: string) => result.trace.steps.some(
    (step) => step.type === "tool" && step.name === toolName,
  );
  const toolError = result.trace.steps.some((step) => step.type === "tool" && !step.ok);
  const checks = [
    expected.shouldComplete === undefined || result.completed === expected.shouldComplete,
    expected.shouldCallTool === undefined || hasTool(expected.shouldCallTool),
    expected.maxModelCalls === undefined || result.metrics.modelCallCount <= expected.maxModelCalls,
    expected.mustNotError === undefined || !expected.mustNotError || !toolError,
  ];
  return { passed: checks.every(Boolean), checks };
}

async function evaluateItem(input: LangfuseEvalInput, expected: unknown, live: boolean) {
  if (input.kind === "routing") {
    // Router imports runtime configuration, so load it only for an actual routing evaluation.
    const { buildRetrievalPlan } = await import("../lib/agent/rag/retrieval-router");
    const plan = buildRetrievalPlan({
      query: input.query,
      knowledgeProfile: input.knowledgeProfile,
      webEnabled: input.webEnabled,
    });
    const expectedRoute = (expected as { expectedRoute: string }).expectedRoute;
    return {
      output: { predictedRoute: plan.route, reason: plan.reason },
      score: plan.route === expectedRoute ? 1 : 0,
      scoreName: "routing_correct（检索路由是否符合预期）",
    };
  }

  if (!live) {
    throw new Error("Agent 用例需要 --live 才会调用真实模型；可先运行 --kind routing。");
  }
  // Agent runner loads provider configuration; Dataset sync must not require model credentials.
  const { runCase } = await import("../lib/agent/eval/runner");
  const result = await runCase(input.messages);
  const evaluation = agentChecks(result, expected as EvalCase["expect"]);
  return {
    output: {
      completed: result.completed,
      stopReason: result.stopReason,
      metrics: result.metrics,
      passedChecks: evaluation.checks,
    },
    score: evaluation.passed ? 1 : 0,
    scoreName: "eval_case_pass（Agent 用例断言是否全部通过）",
  };
}

async function runDataset(langfuse: Langfuse, options: CliOptions) {
  const dataset = await langfuse.getDataset(options.dataset);
  const items = dataset.items.filter((item) =>
    isLangfuseEvalInput(item.input) && (!options.kind || item.input.kind === options.kind),
  );
  if (items.length === 0) throw new Error("没有找到可执行的 Dataset Item；请先运行 --sync。");

  let passed = 0;
  const failedCaseIds: string[] = [];
  for (const item of items) {
    const input = item.input as LangfuseEvalInput;
    const executionBoundary = input.kind === "routing" ? "retrieval-router" : "runAgentLoop";
    const trace = langfuse.trace({
      name: `agent-eval:${input.kind}`,
      input,
      metadata: {
        datasetName: options.dataset,
        datasetItemId: item.id,
        caseId: input.caseId,
        executionBoundary,
      },
    });
    await item.link(trace, options.runName, {
      description: "Personal Assistant offline evaluation run",
      metadata: {
        executionBoundary,
        liveModel: options.live,
      },
    });

    try {
      const evaluation = await evaluateItem(input, item.expectedOutput, options.live);
      passed += evaluation.score;
      if (evaluation.score === 0) failedCaseIds.push(input.caseId);
      trace.update({ output: evaluation.output });
      trace.score({ name: evaluation.scoreName, value: evaluation.score, dataType: "NUMERIC" });
    } catch (error: any) {
      failedCaseIds.push(input.caseId);
      trace.update({
        output: { error: error.message || "未知错误" },
      });
      trace.score({
        name: "eval_case_pass（Agent 用例断言是否全部通过）",
        value: 0,
        dataType: "NUMERIC",
      });
      console.error(`[langfuse-eval] ${input.caseId} 失败:`, error.message || error);
    }
  }

  await langfuse.flushAsync();
  console.log(JSON.stringify({
    dataset: options.dataset,
    runName: options.runName,
    cases: items.length,
    passed,
    failedCaseIds,
    passRate: passed / items.length,
    executionBoundary: options.kind === "routing"
      ? "retrieval-router"
      : options.kind === "agent" ? "runAgentLoop" : "mixed",
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const langfuse = createLangfuse();
  if (options.sync) await syncDataset(langfuse, options.dataset);
  if (options.run) await runDataset(langfuse, options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
