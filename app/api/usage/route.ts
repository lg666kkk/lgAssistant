import { meteredModelOptions } from "@/lib/agent/observability/metered-models";
import { aggregateUsageTraces } from "@/lib/agent/observability/usage-aggregation";
import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import { requireUser } from "@/lib/auth/server";
import { listUserLlmCatalog } from "@/lib/llm/config-service";
import { listUserMeteredModelPricing } from "@/lib/agent/observability/user-metered-pricing";

type UsageRange = "24h" | "7d" | "30d" | "all";

function parseRange(value: string | null): UsageRange {
  return value === "7d" || value === "30d" || value === "all" ? value : "24h";
}

function rangeStart(range: UsageRange, now: Date) {
  if (range === "all") return undefined;
  const durationMs = range === "24h" ? 86_400_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - durationMs);
}

function bucketStart(value: string, range: UsageRange) {
  const date = new Date(value);
  if (range === "24h") date.setMinutes(0, 0, 0);
  else date.setHours(0, 0, 0, 0);
  return date;
}

function bucketLabel(date: Date, range: UsageRange) {
  return range === "24h"
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function combineTimelineUsages(
  events: Array<{ usage: ReturnType<typeof aggregateUsageTraces>["timeline"][number]["usage"] }>,
) {
  const first = events[0]?.usage;
  if (!first) return undefined;
  const summary = {
    ...first,
    requestCount: 1,
    modelCallCount: 0,
    cacheHitCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostCny: 0,
    cacheSavedCostCny: 0,
    unpricedTokens: 0,
  };
  const sources = new Set<string>();
  for (const event of events) {
    const usage = event.usage;
    sources.add(usage.pricingSource);
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
    summary.unpricedTokens += usage.unpricedTokens;
  }
  summary.pricingConfigured = summary.unpricedTokens === 0;
  summary.pricingSource = sources.size === 1 ? first.pricingSource : "mixed";
  summary.cacheHitRate = summary.cacheHitTokens + summary.cacheMissTokens > 0
    ? summary.cacheHitTokens / (summary.cacheHitTokens + summary.cacheMissTokens)
    : 0;
  return summary;
}

// GET /api/usage?limit=500&page=1&pageSize=20
// 基于 agent_traces 聚合真实 token usage 和估算费用。
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

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
  const range = parseRange(url.searchParams.get("range"));
  const selectedModels = new Set(
    (url.searchParams.get("models") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  const now = new Date();
  const from = rangeStart(range, now);

  const [traceResult, llmCatalog, meteredPricing] = await Promise.all([
    getSupabase()
      .from("agent_traces")
      .select(
        "id, request_id, session_id, total_duration_ms, metrics, steps, created_at, sessions(title)",
        { count: "exact" },
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    listUserLlmCatalog(user.id).catch(() => null),
    listUserMeteredModelPricing(user.id).catch(() => []),
  ]);
  const { data, error, count } = traceResult;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const chatModels = (llmCatalog?.models ?? []).map((item) => {
    const pricing = item.pricing.inputCacheHit !== null
      && item.pricing.inputCacheMiss !== null
      && item.pricing.output !== null
      ? {
          inputCacheHit: item.pricing.inputCacheHit,
          inputCacheMiss: item.pricing.inputCacheMiss,
          output: item.pricing.output,
        }
      : undefined;
    return {
      id: item.id,
      providerModelId: item.modelId,
      name: item.displayName,
      providerName: item.providerName,
      pricing,
    };
  });
  const aggregated = aggregateUsageTraces(data ?? [], {
    chatModels,
    meteredModels: meteredPricing.map((item) => ({
      id: item.modelId,
      name: item.modelName,
      category: item.category,
      inputPriceCnyPerMillionTokens: item.inputPriceCnyPerMillionTokens,
      source: item.source,
    })),
  });
  const filteredTimeline = aggregated.timeline.filter((event) =>
    (!from || new Date(event.createdAt) >= from)
    && (selectedModels.size === 0 || selectedModels.has(event.model)),
  );
  const includedTraceIds = new Set(filteredTimeline.map((event) => event.traceId));
  const eventsByTrace = new Map<string, typeof filteredTimeline>();
  for (const event of filteredTimeline) {
    const events = eventsByTrace.get(event.traceId) ?? [];
    events.push(event);
    eventsByTrace.set(event.traceId, events);
  }
  const filteredRequests = aggregated.requests
    .filter((request) => includedTraceIds.has(request.id))
    .map((request) => ({
      ...request,
      usage: combineTimelineUsages(eventsByTrace.get(request.id) ?? []) ?? request.usage,
    }));
  const recentRequests = filteredRequests.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const series = new Map<string, {
    timestamp: string;
    label: string;
    values: Record<string, { cost: number; tokens: number; calls: number; unpricedTokens: number }>;
  }>();
  for (const event of filteredTimeline) {
    const start = bucketStart(event.createdAt, range);
    const key = start.toISOString();
    const point = series.get(key) ?? {
      timestamp: key,
      label: bucketLabel(start, range),
      values: {},
    };
    const current = point.values[event.model] ?? { cost: 0, tokens: 0, calls: 0, unpricedTokens: 0 };
    current.cost += event.usage.estimatedCostCny;
    current.tokens += event.usage.totalTokens;
    current.calls += event.usage.modelCallCount;
    current.unpricedTokens += event.usage.unpricedTokens;
    point.values[event.model] = current;
    series.set(key, point);
  }
  const modelSummaries = aggregated.models.filter((model) =>
    filteredTimeline.some((event) => event.model === model.model));
  const summaryByModel = new Map(modelSummaries.map((model) => [model.model, {
    ...model,
    requestCount: 0,
    modelCallCount: 0,
    cacheHitCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostCny: 0,
    cacheSavedCostCny: 0,
    unpricedTokens: 0,
  }]));
  for (const event of filteredTimeline) {
    const summary = summaryByModel.get(event.model);
    if (!summary) continue;
    summary.requestCount += 1;
    summary.modelCallCount += event.usage.modelCallCount;
    summary.cacheHitCalls += event.usage.cacheHitCalls;
    summary.inputTokens += event.usage.inputTokens;
    summary.outputTokens += event.usage.outputTokens;
    summary.totalTokens += event.usage.totalTokens;
    summary.cacheHitTokens += event.usage.cacheHitTokens;
    summary.cacheMissTokens += event.usage.cacheMissTokens;
    summary.cacheCreationTokens += event.usage.cacheCreationTokens;
    summary.estimatedCostCny += event.usage.estimatedCostCny;
    summary.cacheSavedCostCny += event.usage.cacheSavedCostCny;
    summary.unpricedTokens += event.usage.unpricedTokens;
  }
  const filteredModels = Array.from(summaryByModel.values()).map((model) => ({
    ...model,
    pricingConfigured: model.unpricedTokens === 0,
    cacheHitRate: model.cacheHitTokens + model.cacheMissTokens > 0
      ? model.cacheHitTokens / (model.cacheHitTokens + model.cacheMissTokens)
      : 0,
  })).sort((left, right) => right.estimatedCostCny - left.estimatedCostCny);
  const total = filteredModels.reduce((sum, model) => ({
    ...sum,
    requestCount: filteredRequests.length,
    modelCallCount: sum.modelCallCount + model.modelCallCount,
    cacheHitCalls: sum.cacheHitCalls + model.cacheHitCalls,
    inputTokens: sum.inputTokens + model.inputTokens,
    outputTokens: sum.outputTokens + model.outputTokens,
    totalTokens: sum.totalTokens + model.totalTokens,
    cacheHitTokens: sum.cacheHitTokens + model.cacheHitTokens,
    cacheMissTokens: sum.cacheMissTokens + model.cacheMissTokens,
    estimatedCostCny: sum.estimatedCostCny + model.estimatedCostCny,
    cacheSavedCostCny: sum.cacheSavedCostCny + model.cacheSavedCostCny,
    unpricedTokens: sum.unpricedTokens + model.unpricedTokens,
    cacheCreationTokens: sum.cacheCreationTokens + model.cacheCreationTokens,
  }), { ...aggregated.total, requestCount: 0, modelCallCount: 0, cacheHitCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cacheCreationTokens: 0, estimatedCostCny: 0, cacheSavedCostCny: 0, unpricedTokens: 0 });
  total.pricingConfigured = total.unpricedTokens === 0;
  total.cacheHitRate = total.cacheHitTokens + total.cacheMissTokens > 0
    ? total.cacheHitTokens / (total.cacheHitTokens + total.cacheMissTokens)
    : 0;
  const observedStart = from ?? filteredRequests.reduce<Date | undefined>((earliest, request) => {
    const createdAt = new Date(request.createdAt);
    return !earliest || createdAt < earliest ? createdAt : earliest;
  }, undefined) ?? now;
  const observedMinutes = Math.max(1, (now.getTime() - observedStart.getTime()) / 60_000);

  return Response.json({
    total,
    models: filteredModels,
    availableModels: aggregated.models.map((model) => ({
      id: model.model,
      name: model.modelName,
      providerName: model.providerName,
      category: model.category,
    })),
    timeline: Array.from(series.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    analytics: {
      range,
      observedMinutes,
      averageRpm: filteredRequests.length / observedMinutes,
      averageTpm: total.totalTokens / observedMinutes,
    },
    recentRequests,
    pagination: {
      page,
      pageSize,
      totalItems: filteredRequests.length,
      totalTraceCount: count ?? null,
      hasPreviousPage: page > 1,
      hasNextPage: page * pageSize < filteredRequests.length,
    },
    knownModels: [
      ...(llmCatalog?.models ?? []).map((item) => ({
        id: item.id,
        name: `${item.providerName} / ${item.displayName}`,
        category: "chat" as const,
        pricing: item.pricing,
      })),
      ...meteredModelOptions.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        pricing: { input: item.inputCnyPerMillionTokens },
      })),
    ],
  });
}
