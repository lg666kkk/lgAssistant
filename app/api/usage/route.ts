import {
  calculateModelUsageCost,
  chatModelOptions,
  type ChatModelId,
} from "@/lib/agent/models";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";

type UsageSummary = {
  model: string;
  modelName: string;
  requestCount: number;
  modelCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  estimatedCostCny: number;
};

type UsageRequestSummary = {
  id: string;
  requestId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  model: string;
  createdAt: string;
  totalDurationMs: number | null;
  usage: UsageSummary;
};

function emptySummary(model: string): UsageSummary {
  const option = chatModelOptions.find((item) => item.id === model);
  return {
    model,
    modelName: option?.name ?? model,
    requestCount: 0,
    modelCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: 0,
    estimatedCostCny: 0,
  };
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finalizeSummary(summary: UsageSummary): UsageSummary {
  const measuredInput = summary.cacheHitTokens + summary.cacheMissTokens;
  return {
    ...summary,
    cacheHitRate:
      measuredInput > 0 ? summary.cacheHitTokens / measuredInput : 0,
  };
}

function getStepModel(step: any): string {
  return typeof step?.model === "string" ? step.model : "unknown";
}

function getTracePrimaryModel(trace: any): string {
  const modelStep = Array.isArray(trace.steps)
    ? trace.steps.find((step: any) => step?.type === "model" && step?.model)
    : undefined;
  return getStepModel(modelStep);
}

function normalizeStepUsage(model: string, usage: any) {
  const inputTokens = toNumber(usage?.inputTokens);
  const outputTokens = toNumber(usage?.outputTokens);
  const cacheHitTokens = toNumber(usage?.cacheHitTokens);
  const cacheCreationTokens = toNumber(usage?.cacheCreationTokens);
  const cacheMissTokens =
    usage?.cacheMissTokens == null
      ? Math.max(0, inputTokens - cacheHitTokens + cacheCreationTokens)
      : toNumber(usage.cacheMissTokens);
  const totalTokens =
    usage?.totalTokens == null
      ? inputTokens + outputTokens
      : toNumber(usage.totalTokens);

  if (typeof usage?.estimatedCostCny === "number") {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheCreationTokens,
      estimatedCostCny: usage.estimatedCostCny,
    };
  }

  const estimated = calculateModelUsageCost(
    chatModelOptions.some((item) => item.id === model)
      ? (model as ChatModelId)
      : "deepseek-v4-pro",
    {
      inputTokens,
      outputTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheCreationTokens,
    },
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens,
    estimatedCostCny: estimated.estimatedCostCny,
  };
}

// GET /api/usage?limit=500&page=1&pageSize=20
// 基于 agent_traces 聚合真实 token usage 和估算费用。
export async function GET(req: Request) {
  if (!hasSupabaseConfig()) {
    return Response.json(
      { error: "未配置 Supabase，无法读取 usage" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(
    Math.max(5, Number(url.searchParams.get("pageSize")) || 20),
    100,
  );

  const { data, error, count } = await getSupabase()
    .from("agent_traces")
    .select(
      "id, request_id, session_id, total_duration_ms, metrics, steps, created_at, sessions(title)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const byModel = new Map<string, UsageSummary>();
  const allRequests: UsageRequestSummary[] = (data ?? []).map((trace: any) => {
    const primaryModel = getTracePrimaryModel(trace);
    const requestSummary = emptySummary(primaryModel);
    requestSummary.requestCount = 1;

    const seenModelsInRequest = new Set<string>();
    for (const step of Array.isArray(trace.steps) ? trace.steps : []) {
      if (step?.type !== "model" || !step.usage) continue;
      const model = getStepModel(step);
      const usage = normalizeStepUsage(model, step.usage);
      seenModelsInRequest.add(model);
      const summary = byModel.get(model) ?? emptySummary(model);
      summary.modelCallCount += 1;
      summary.inputTokens += usage.inputTokens;
      summary.outputTokens += usage.outputTokens;
      summary.totalTokens += usage.totalTokens;
      summary.cacheHitTokens += usage.cacheHitTokens;
      summary.cacheMissTokens += usage.cacheMissTokens;
      summary.cacheCreationTokens += usage.cacheCreationTokens;
      summary.estimatedCostCny += usage.estimatedCostCny;
      byModel.set(model, summary);

      requestSummary.modelCallCount += 1;
      requestSummary.inputTokens += usage.inputTokens;
      requestSummary.outputTokens += usage.outputTokens;
      requestSummary.totalTokens += usage.totalTokens;
      requestSummary.cacheHitTokens += usage.cacheHitTokens;
      requestSummary.cacheMissTokens += usage.cacheMissTokens;
      requestSummary.cacheCreationTokens += usage.cacheCreationTokens;
      requestSummary.estimatedCostCny += usage.estimatedCostCny;
    }

    for (const model of Array.from(seenModelsInRequest)) {
      const summary = byModel.get(model);
      if (summary) summary.requestCount += 1;
    }

    return {
      id: trace.id,
      requestId: trace.request_id,
      sessionId: trace.session_id,
      sessionTitle: trace.sessions?.title ?? null,
      model: primaryModel,
      createdAt: trace.created_at,
      totalDurationMs: trace.total_duration_ms,
      usage: finalizeSummary(requestSummary),
    };
  });
  const usageRequests = allRequests.filter(
    (item) => item.usage.modelCallCount > 0,
  );
  const recentRequests = usageRequests.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const modelSummaries = Array.from(byModel.values())
    .map(finalizeSummary)
    .sort((a, b) => b.estimatedCostCny - a.estimatedCostCny);

  const total = finalizeSummary(
    modelSummaries.reduce((sum, item) => {
      sum.requestCount += item.requestCount;
      sum.modelCallCount += item.modelCallCount;
      sum.inputTokens += item.inputTokens;
      sum.outputTokens += item.outputTokens;
      sum.totalTokens += item.totalTokens;
      sum.cacheHitTokens += item.cacheHitTokens;
      sum.cacheMissTokens += item.cacheMissTokens;
      sum.cacheCreationTokens += item.cacheCreationTokens;
      sum.estimatedCostCny += item.estimatedCostCny;
      return sum;
    }, emptySummary("all")),
  );

  return Response.json({
    total,
    models: modelSummaries,
    recentRequests,
    pagination: {
      page,
      pageSize,
      totalItems: usageRequests.length,
      totalTraceCount: count ?? null,
      hasPreviousPage: page > 1,
      hasNextPage: page * pageSize < usageRequests.length,
    },
    knownModels: chatModelOptions.map((item) => ({
      id: item.id satisfies ChatModelId,
      name: item.name,
      pricing: item.pricing,
    })),
  });
}
