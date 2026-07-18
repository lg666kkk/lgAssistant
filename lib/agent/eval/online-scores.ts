import { Langfuse } from "langfuse";
import type { AgentTrace } from "@/lib/agent/runtime/trace";

export type OnlineScore = {
  name: string;
  value: number;
};

type LangfuseScoreClient = Pick<Langfuse, "score" | "flushAsync">;

let client: LangfuseScoreClient | undefined;

function getClient(): LangfuseScoreClient | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;

  // 评分仅在请求终态才需要；延迟初始化避免未配置 Langfuse 的环境产生副作用。
  client ??= new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  return client;
}

function latestValidation(trace: AgentTrace) {
  // 一个请求可能有多段执行，末次 answer_validation 才对应最终回答。
  return [...trace.steps]
    .reverse()
    .find((step) => step.type === "answer_validation");
}

export function buildOnlineScores(trace: AgentTrace): OnlineScore[] {
  const toolSteps = trace.steps.filter((step) => step.type === "tool");
  const failedTools = toolSteps.filter((step) => !step.ok);
  const validation = latestValidation(trace);
  // 先记录所有请求都具备的运行指标；RAG 质量指标仅在实际完成证据校验后上报。
  const scores: OnlineScore[] = [
    { name: "agent_completed（Agent 是否正常完成）", value: trace.completed ? 1 : 0 },
    {
      name: "tool_error_rate（工具调用失败率）",
      value: toolSteps.length === 0 ? 0 : failedTools.length / toolSteps.length,
    },
    { name: "model_call_count（模型调用次数）", value: trace.metrics.modelCallCount },
    { name: "latency_ms（端到端耗时，毫秒）", value: trace.totalDurationMs ?? 0 },
  ];

  if (validation) {
    scores.push(
      { name: "groundedness（回答主张的证据支撑率）", value: validation.report.groundedness },
      { name: "citation_precision（引用证据有效率）", value: validation.report.citationPrecision },
      { name: "citation_coverage（回答主张的引用覆盖率）", value: validation.report.citationCoverage },
      {
        name: "retrieval_evidence_ok（检索证据是否通过校验）",
        value: validation.report.status === "pass" ? 1 : 0,
      },
    );
  }

  return scores;
}

export async function reportOnlineScores(input: {
  traceId: string;
  trace: AgentTrace;
  environment?: string;
  scoreClient?: LangfuseScoreClient;
}) {
  const scoreClient = input.scoreClient ?? getClient();
  if (!scoreClient) return;

  for (const score of buildOnlineScores(input.trace)) {
    // 所有分数绑定同一个 Langfuse trace，便于在单次运行详情与聚合视图中关联分析。
    scoreClient.score({
      traceId: input.traceId,
      name: score.name,
      value: score.value,
      dataType: "NUMERIC",
      environment: input.environment ?? process.env.NODE_ENV ?? "development",
      metadata: {
        requestId: input.trace.requestId,
        stopReason: input.trace.stopReason,
        scoreVersion: "online-v1",
      },
    });
  }

  // score() 进入 SDK 队列；终态前 flush 以降低短生命周期运行时丢失评分的概率。
  await scoreClient.flushAsync();
}
