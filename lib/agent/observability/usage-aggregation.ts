import {
  calculateModelUsageCost,
  chatModelOptions,
  getModelPricing,
  type ModelPricingCnyPerMillionTokens,
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
  providerName?: string;
  category: UsageCategory;
  inputPriceCnyPerMillionTokens?: number;
  pricing?: ModelPricingCnyPerMillionTokens;
  pricingSource: "trace" | "current" | "static" | "mixed" | "unknown";
  pricingConfigured: boolean;
  unpricedTokens: number;
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

export type UsageTimelineEvent = {
  traceId: string;
  requestId: string;
  createdAt: string;
  model: string;
  usage: UsageSummary;
};

type NormalizedUsage = Omit<
  UsageSummary,
  "requestCount" | "cacheHitRate"
>;

export type UsageChatModelDefinition = {
  id: string;
  providerModelId?: string;
  name: string;
  providerName?: string;
  pricing?: ModelPricingCnyPerMillionTokens;
};

export type UsageMeteredModelDefinition = {
  id: string;
  name: string;
  category: "embedding" | "rerank";
  inputPriceCnyPerMillionTokens: number | null;
  source?: "database" | "static" | "unset";
};

type AggregateUsageOptions = {
  chatModels?: UsageChatModelDefinition[];
  meteredModels?: UsageMeteredModelDefinition[];
};

function emptySummary(
  model: string,
  category: UsageCategory = "chat",
  chatModel?: UsageChatModelDefinition,
): UsageSummary {
  const chat = chatModelOptions.find((item) => item.id === model);
  const metered = getMeteredModelOption(model);
  const pricing = chatModel?.pricing ?? chat?.pricing;
  return {
    model,
    modelName: chatModel?.name ?? chat?.name ?? metered?.name ?? model,
    providerName: chatModel?.providerName,
    category: metered?.category ?? category,
    inputPriceCnyPerMillionTokens: metered?.inputCnyPerMillionTokens,
    pricing,
    pricingSource: pricing ? (chatModel?.pricing ? "current" : "static") : metered ? "static" : "unknown",
    pricingConfigured: Boolean(pricing || metered),
    unpricedTokens: 0,
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

function validPricing(value: unknown): ModelPricingCnyPerMillionTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pricing = value as Record<string, unknown>;
  if (
    typeof pricing.inputCacheHit !== "number"
    || typeof pricing.inputCacheMiss !== "number"
    || typeof pricing.output !== "number"
    || !Number.isFinite(pricing.inputCacheHit)
    || !Number.isFinite(pricing.inputCacheMiss)
    || !Number.isFinite(pricing.output)
    || pricing.inputCacheHit < 0
    || pricing.inputCacheMiss < 0
    || pricing.output < 0
  ) return undefined;
  return {
    inputCacheHit: pricing.inputCacheHit,
    inputCacheMiss: pricing.inputCacheMiss,
    output: pricing.output,
  };
}

function normalizeChatUsage(
  model: string,
  usage: any,
  step: any,
  currentModel?: UsageChatModelDefinition,
): NormalizedUsage {
  const canonicalModel = typeof step?.providerModelId === "string" && step.providerModelId.trim()
    ? step.providerModelId.trim()
    : currentModel?.providerModelId?.trim() || model;
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
  const resolvedModel = canonicalModel as ChatModelId;
  const tracePricing = validPricing(step?.pricingSnapshot) ?? validPricing(usage?.pricing);
  const currentPricing = currentModel?.pricing;
  const staticPricing = chatModelOptions.some((item) => item.id === canonicalModel)
    ? getModelPricing(canonicalModel)
    : undefined;
  const pricing = tracePricing ?? currentPricing ?? staticPricing;
  const pricingSource = tracePricing
    ? "trace" as const
    : currentPricing ? "current" as const : staticPricing ? "static" as const : "unknown" as const;
  const costs = calculateModelUsageCost(resolvedModel, {
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens,
  }, pricing);
  const estimated = pricing
    ? costs.estimatedCostCny
    : typeof usage?.estimatedCostCny === "number" && usage?.pricingConfigured !== false
      ? usage.estimatedCostCny
      : 0;
  const cacheSavedCostCny =
    (cacheHitTokens / 1_000_000)
    * Math.max(0, (pricing?.inputCacheMiss ?? 0) - (pricing?.inputCacheHit ?? 0));

  return {
    model: canonicalModel,
    modelName: step?.modelName ?? currentModel?.name
      ?? chatModelOptions.find((item) => item.id === canonicalModel)?.name
      ?? canonicalModel,
    providerName: step?.providerName ?? currentModel?.providerName,
    category: "chat",
    pricing,
    pricingSource,
    pricingConfigured: Boolean(pricing),
    unpricedTokens: pricing ? 0 : totalTokens,
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

function resolveMeteredPricing(
  category: "embedding" | "rerank",
  model: string,
  tracePrice: unknown,
  current?: UsageMeteredModelDefinition,
) {
  const validTracePrice = typeof tracePrice === "number" && Number.isFinite(tracePrice) && tracePrice >= 0
    ? tracePrice
    : undefined;
  const currentPrice = current?.inputPriceCnyPerMillionTokens;
  const staticPrice = getMeteredModelOption(model)?.inputCnyPerMillionTokens;
  const price = validTracePrice ?? currentPrice ?? staticPrice;
  return {
    name: current?.name ?? getMeteredModelOption(model)?.name ?? model,
    price: price ?? undefined,
    source: validTracePrice
      ? "trace" as const
      : currentPrice !== null && currentPrice !== undefined
        ? current?.source === "static" ? "static" as const : "current" as const
        : staticPrice !== undefined ? "static" as const : "unknown" as const,
    category,
  };
}

function normalizeEmbeddingUsage(
  usage: any,
  fullResultCacheHit = false,
  current?: UsageMeteredModelDefinition,
): NormalizedUsage | null {
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
  const pricing = resolveMeteredPricing(
    "embedding",
    model,
    usage?.inputPriceCnyPerMillionTokens,
    current,
  );
  const costs = calculateMeteredInputCost(model, {
    billedInputTokens,
    cachedInputTokens: cacheHitTokens,
  }, pricing.price);
  const modelCallCount = fullResultCacheHit ? 0 : toNumber(usage?.modelCallCount);
  const cacheHitCalls = fullResultCacheHit
    ? Math.max(1, toNumber(usage?.modelCallCount) + toNumber(usage?.cacheHitCalls))
    : toNumber(usage?.cacheHitCalls);
  if (billedInputTokens <= 0 && cacheHitTokens <= 0 && modelCallCount <= 0) return null;

  return {
    model,
    modelName: pricing.name,
    category: "embedding",
    inputPriceCnyPerMillionTokens: pricing.price,
    pricingSource: pricing.source,
    pricingConfigured: pricing.price !== undefined,
    unpricedTokens: pricing.price !== undefined ? 0 : billedInputTokens,
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

function normalizeRerankUsage(
  rerank: any,
  current?: UsageMeteredModelDefinition,
): NormalizedUsage | null {
  const totalTokens = toNumber(rerank?.totalTokens);
  if (totalTokens <= 0) return null;
  const model = typeof rerank?.providerModel === "string"
    ? rerank.providerModel
    : typeof rerank?.model === "string"
      ? rerank.model
      : "qwen3-rerank";
  const pricing = resolveMeteredPricing(
    "rerank",
    model,
    rerank?.inputPriceCnyPerMillionTokens,
    current,
  );
  const costs = calculateMeteredInputCost(
    model,
    { billedInputTokens: totalTokens },
    pricing.price,
  );
  return {
    model,
    modelName: pricing.name,
    category: "rerank",
    inputPriceCnyPerMillionTokens: pricing.price,
    pricingSource: pricing.source,
    pricingConfigured: pricing.price !== undefined,
    unpricedTokens: pricing.price !== undefined ? 0 : totalTokens,
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

function collectStepUsages(
  step: any,
  chatModels: ReadonlyMap<string, UsageChatModelDefinition>,
  meteredModels: ReadonlyMap<string, UsageMeteredModelDefinition>,
): NormalizedUsage[] {
  if (step?.type === "model" && step.usage) {
    const model = typeof step.model === "string" ? step.model : "unknown";
    return [normalizeChatUsage(model, step.usage, step, chatModels.get(model))];
  }
  if (step?.type === "memory_recall") {
    return [
      normalizeEmbeddingUsage(
        step.embeddingUsage,
        false,
        meteredModels.get(`embedding:${step.embeddingUsage?.model ?? "text-embedding-v4"}`),
      ),
      normalizeRerankUsage(
        step.rerank,
        meteredModels.get(`rerank:${step.rerank?.providerModel ?? step.rerank?.model ?? "qwen3-rerank"}`),
      ),
    ].filter((usage): usage is NormalizedUsage => Boolean(usage));
  }
  if (step?.type === "retrieval" && Array.isArray(step.attempts)) {
    return step.attempts.flatMap((attempt: any) => {
      const usage = normalizeEmbeddingUsage(
        attempt?.debug?.embeddingUsage,
        attempt?.cacheHit === true,
        meteredModels.get(`embedding:${attempt?.debug?.embeddingUsage?.model ?? "text-embedding-v4"}`),
      );
      const rerank = normalizeRerankUsage(
        attempt?.debug?.crossEncoderUsage,
        meteredModels.get(`rerank:${attempt?.debug?.crossEncoderUsage?.providerModel ?? attempt?.debug?.crossEncoderUsage?.model ?? "qwen3-rerank"}`),
      );
      return [usage, rerank].filter((item): item is NormalizedUsage => Boolean(item));
    });
  }
  if (step?.type === "tool" && step.name === "recall_memory") {
    return [
      normalizeEmbeddingUsage(
        step.metadata?.memoryEmbeddingUsage,
        false,
        meteredModels.get(`embedding:${step.metadata?.memoryEmbeddingUsage?.model ?? "text-embedding-v4"}`),
      ),
      normalizeRerankUsage(
        step.metadata?.memoryRerank,
        meteredModels.get(`rerank:${step.metadata?.memoryRerank?.providerModel ?? step.metadata?.memoryRerank?.model ?? "qwen3-rerank"}`),
      ),
    ].filter((usage): usage is NormalizedUsage => Boolean(usage));
  }
  return [];
}

function addUsage(summary: UsageSummary, usage: NormalizedUsage) {
  const wasEmpty = summary.modelCallCount === 0
    && summary.cacheHitCalls === 0
    && summary.totalTokens === 0;
  if (
    usage.pricingSource === "trace"
    || usage.pricingSource === "current"
    || (summary.modelName === summary.model && usage.modelName !== usage.model)
  ) {
    summary.modelName = usage.modelName;
  }
  if (usage.pricingSource === "trace" && usage.providerName) {
    summary.providerName = usage.providerName;
  } else {
    summary.providerName ??= usage.providerName;
  }
  summary.pricing ??= usage.pricing;
  if (
    usage.pricingSource === "trace"
    || usage.pricingSource === "current"
    || summary.inputPriceCnyPerMillionTokens === undefined
  ) {
    summary.inputPriceCnyPerMillionTokens = usage.inputPriceCnyPerMillionTokens;
  }
  if (wasEmpty || summary.pricingSource === "unknown") summary.pricingSource = usage.pricingSource;
  else if (summary.pricingSource !== usage.pricingSource) summary.pricingSource = "mixed";
  summary.unpricedTokens += usage.unpricedTokens;
  summary.pricingConfigured = summary.unpricedTokens === 0;
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

export function aggregateUsageTraces(
  traces: any[],
  options: AggregateUsageOptions = {},
) {
  const providerModelCounts = new Map<string, number>();
  for (const model of options.chatModels ?? []) {
    if (!model.providerModelId) continue;
    providerModelCounts.set(
      model.providerModelId,
      (providerModelCounts.get(model.providerModelId) ?? 0) + 1,
    );
  }
  const chatModels = new Map((options.chatModels ?? []).map((model) => [
    model.id,
    {
      ...model,
      providerModelId: model.providerModelId
        && providerModelCounts.get(model.providerModelId) === 1
        ? model.providerModelId
        : undefined,
    },
  ]));
  const meteredModels = new Map((options.meteredModels ?? []).map((model) => [`${model.category}:${model.id}`, model]));
  const byModel = new Map<string, UsageSummary>();
  const timeline: UsageTimelineEvent[] = [];
  const requests: UsageRequestSummary[] = traces.map((trace) => {
    const primaryModel = getTracePrimaryModel(trace);
    const requestSummary = emptySummary(primaryModel, "all", chatModels.get(primaryModel));
    requestSummary.requestCount = 1;
    const seenModels = new Set<string>();
    const requestModels = new Map<string, UsageSummary>();

    for (const step of Array.isArray(trace?.steps) ? trace.steps : []) {
      for (const usage of collectStepUsages(step, chatModels, meteredModels)) {
        seenModels.add(usage.model);
        const summary = byModel.get(usage.model)
          ?? emptySummary(usage.model, usage.category, chatModels.get(usage.model));
        addUsage(summary, usage);
        byModel.set(usage.model, summary);
        const requestModel = requestModels.get(usage.model)
          ?? emptySummary(usage.model, usage.category, chatModels.get(usage.model));
        addUsage(requestModel, usage);
        requestModels.set(usage.model, requestModel);
        addUsage(requestSummary, usage);
      }
    }
    for (const [model, summary] of Array.from(requestModels.entries())) {
      summary.requestCount = 1;
      timeline.push({
        traceId: trace.id,
        requestId: trace.request_id,
        createdAt: trace.created_at,
        model,
        usage: finalizeSummary(summary),
      });
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
    timeline,
  };
}
