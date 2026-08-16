import {
  calculateModelUsageCost,
  chatModelOptions,
  getModelPricing,
  type ChatModelId,
} from "@/lib/agent/models";
import {
  calculateMeteredInputCost,
  getMeteredModelOption,
} from "./metered-models";

export type UsageCategory = "all" | "chat" | "embedding" | "rerank";

export type UsageSummary = {
  model: string;
  modelName: string;
  category: UsageCategory;
  inputPriceCnyPerMillionTokens?: number;
  requestCount: number;
  modelCallCount: number;
  cacheHitCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  estimatedCostCny: number;
  cacheSavedCostCny: number;
};

export type UsageRequestSummary = {
  id: string;
  requestId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  model: string;
  createdAt: string;
  totalDurationMs: number | null;
  usage: UsageSummary;
};

type NormalizedUsage = Omit<
  UsageSummary,
  "modelName" | "requestCount" | "cacheHitRate" | "inputPriceCnyPerMillionTokens"
>;

function emptySummary(model: string, category: UsageCategory = "chat"): UsageSummary {
  const chat = chatModelOptions.find((item) => item.id === model);
  const metered = getMeteredModelOption(model);
  return {
    model,
    modelName: chat?.name ?? metered?.name ?? model,
    category: metered?.category ?? category,
    inputPriceCnyPerMillionTokens: metered?.inputCnyPerMillionTokens,
    requestCount: 0,
    modelCallCount: 0,
    cacheHitCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: 0,
    estimatedCostCny: 0,
    cacheSavedCostCny: 0,
  };
}

function toNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function finalizeSummary(summary: UsageSummary): UsageSummary {
  const measuredInput = summary.cacheHitTokens + summary.cacheMissTokens;
  return {
    ...summary,
    cacheHitRate: measuredInput > 0 ? summary.cacheHitTokens / measuredInput : 0,
  };
}

function normalizeChatUsage(model: string, usage: any): NormalizedUsage {
  const inputTokens = toNumber(usage?.inputTokens);
  const outputTokens = toNumber(usage?.outputTokens);
  const cacheHitTokens = toNumber(usage?.cacheHitTokens);
  const cacheCreationTokens = toNumber(usage?.cacheCreationTokens);
  const cacheMissTokens = usage?.cacheMissTokens == null
    ? Math.max(0, inputTokens - cacheHitTokens + cacheCreationTokens)
    : toNumber(usage.cacheMissTokens);
  const totalTokens = usage?.totalTokens == null
    ? inputTokens + outputTokens
    : toNumber(usage.totalTokens);
  const resolvedModel = chatModelOptions.some((item) => item.id === model)
    ? model as ChatModelId
    : "deepseek-v4-pro";
  const estimated = typeof usage?.estimatedCostCny === "number"
    ? usage.estimatedCostCny
    : calculateModelUsageCost(resolvedModel, {
        inputTokens,
        outputTokens,
        cacheHitTokens,
        cacheMissTokens,
        cacheCreationTokens,
      }).estimatedCostCny;
  const pricing = getModelPricing(resolvedModel);
  const cacheSavedCostCny =
    (cacheHitTokens / 1_000_000)
    * Math.max(0, pricing.inputCacheMiss - pricing.inputCacheHit);

  return {
    model,
    category: "chat",
    modelCallCount: 1,
    cacheHitCalls: cacheHitTokens > 0 ? 1 : 0,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens,
    estimatedCostCny: estimated,
    cacheSavedCostCny,
  };
}

function normalizeEmbeddingUsage(usage: any, fullResultCacheHit = false): NormalizedUsage | null {
  const model = typeof usage?.model === "string" ? usage.model : "text-embedding-v4";
  const inputTokens = toNumber(usage?.inputTokens);
  const ownCacheHitTokens = toNumber(usage?.cacheHitTokens);
  const ownCacheMissTokens = usage?.cacheMissTokens == null
    ? inputTokens
    : toNumber(usage.cacheMissTokens);
  const cachedByFullResult = fullResultCacheHit
    ? ownCacheHitTokens + ownCacheMissTokens
    : 0;
  const cacheHitTokens = fullResultCacheHit ? cachedByFullResult : ownCacheHitTokens;
  const cacheMissTokens = fullResultCacheHit ? 0 : ownCacheMissTokens;
  const billedInputTokens = fullResultCacheHit ? 0 : inputTokens;
  const costs = calculateMeteredInputCost(model, {
    billedInputTokens,
    cachedInputTokens: cacheHitTokens,
  });
  const modelCallCount = fullResultCacheHit ? 0 : toNumber(usage?.modelCallCount);
  const cacheHitCalls = fullResultCacheHit
    ? Math.max(1, toNumber(usage?.modelCallCount) + toNumber(usage?.cacheHitCalls))
    : toNumber(usage?.cacheHitCalls);
  if (billedInputTokens <= 0 && cacheHitTokens <= 0 && modelCallCount <= 0) return null;

  return {
    model,
    category: "embedding",
    modelCallCount,
    cacheHitCalls,
    inputTokens: billedInputTokens,
    outputTokens: 0,
    totalTokens: fullResultCacheHit ? 0 : toNumber(usage?.totalTokens) || billedInputTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens: 0,
    estimatedCostCny: costs.estimatedCostCny,
    cacheSavedCostCny: costs.cacheSavedCostCny,
  };
}

function normalizeRerankUsage(rerank: any): NormalizedUsage | null {
  const totalTokens = toNumber(rerank?.totalTokens);
  if (totalTokens <= 0) return null;
  const model = typeof rerank?.providerModel === "string"
    ? rerank.providerModel
    : typeof rerank?.model === "string"
      ? rerank.model
      : "qwen3-rerank";
  const costs = calculateMeteredInputCost(model, { billedInputTokens: totalTokens });
  return {
    model,
    category: "rerank",
    modelCallCount: 1,
    cacheHitCalls: 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    cacheHitTokens: 0,
    cacheMissTokens: totalTokens,
    cacheCreationTokens: 0,
    estimatedCostCny: costs.estimatedCostCny,
    cacheSavedCostCny: 0,
  };
}

function collectStepUsages(step: any): NormalizedUsage[] {
  if (step?.type === "model" && step.usage) {
    const model = typeof step.model === "string" ? step.model : "unknown";
    return [normalizeChatUsage(model, step.usage)];
  }
  if (step?.type === "memory_recall") {
    return [
      normalizeEmbeddingUsage(step.embeddingUsage),
      normalizeRerankUsage(step.rerank),
    ].filter((usage): usage is NormalizedUsage => Boolean(usage));
  }
  if (step?.type === "retrieval" && Array.isArray(step.attempts)) {
    return step.attempts.flatMap((attempt: any) => {
      const usage = normalizeEmbeddingUsage(
        attempt?.debug?.embeddingUsage,
        attempt?.cacheHit === true,
      );
      return usage ? [usage] : [];
    });
  }
  if (step?.type === "tool" && step.name === "recall_memory") {
    return [
      normalizeEmbeddingUsage(step.metadata?.memoryEmbeddingUsage),
      normalizeRerankUsage(step.metadata?.memoryRerank),
    ].filter((usage): usage is NormalizedUsage => Boolean(usage));
  }
  return [];
}

function addUsage(summary: UsageSummary, usage: NormalizedUsage) {
  summary.modelCallCount += usage.modelCallCount;
  summary.cacheHitCalls += usage.cacheHitCalls;
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.totalTokens += usage.totalTokens;
  summary.cacheHitTokens += usage.cacheHitTokens;
  summary.cacheMissTokens += usage.cacheMissTokens;
  summary.cacheCreationTokens += usage.cacheCreationTokens;
  summary.estimatedCostCny += usage.estimatedCostCny;
  summary.cacheSavedCostCny += usage.cacheSavedCostCny;
}

function getTracePrimaryModel(trace: any): string {
  const modelStep = Array.isArray(trace?.steps)
    ? trace.steps.find((step: any) => step?.type === "model" && step?.model)
    : undefined;
  return typeof modelStep?.model === "string" ? modelStep.model : "unknown";
}

export function aggregateUsageTraces(traces: any[]) {
  const byModel = new Map<string, UsageSummary>();
  const requests: UsageRequestSummary[] = traces.map((trace) => {
    const primaryModel = getTracePrimaryModel(trace);
    const requestSummary = emptySummary(primaryModel, "all");
    requestSummary.requestCount = 1;
    const seenModels = new Set<string>();

    for (const step of Array.isArray(trace?.steps) ? trace.steps : []) {
      for (const usage of collectStepUsages(step)) {
        seenModels.add(usage.model);
        const summary = byModel.get(usage.model)
          ?? emptySummary(usage.model, usage.category);
        addUsage(summary, usage);
        byModel.set(usage.model, summary);
        addUsage(requestSummary, usage);
      }
    }
    for (const model of Array.from(seenModels)) {
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
  }).filter((request) =>
    request.usage.modelCallCount > 0 || request.usage.cacheHitCalls > 0);

  const models = Array.from(byModel.values())
    .map(finalizeSummary)
    .sort((left, right) => right.estimatedCostCny - left.estimatedCostCny);
  const total = models.reduce((sum, model) => {
    addUsage(sum, {
      ...model,
      category: model.category === "all" ? "chat" : model.category,
    });
    return sum;
  }, emptySummary("all", "all"));
  total.requestCount = requests.length;

  return {
    total: finalizeSummary(total),
    models,
    requests,
  };
}
