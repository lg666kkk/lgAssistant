"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AreaChart as AreaChartIcon,
  BarChart3,
  Bot,
  BrainCircuit,
  Coins,
  Database,
  Filter,
  Gauge,
  Hash,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Save,
  SlidersHorizontal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { authFetch } from "@web/lib/auth/client";

type UsageSummary = {
  model: string;
  modelName: string;
  providerName?: string;
  category: "all" | "chat" | "embedding" | "rerank";
  pricingSource: "trace" | "current" | "static" | "mixed" | "unknown";
  pricingConfigured: boolean;
  unpricedTokens: number;
  pricing?: { inputCacheHit: number; inputCacheMiss: number; output: number };
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

type UsageResponse = {
  total: UsageSummary;
  models: UsageSummary[];
  availableModels: Array<{
    id: string;
    name: string;
    providerName?: string;
    category: UsageSummary["category"];
  }>;
  timeline: Array<{
    timestamp: string;
    label: string;
    values: Record<string, { cost: number; tokens: number; calls: number; unpricedTokens: number }>;
  }>;
  analytics: {
    range: UsageRange;
    observedMinutes: number;
    averageRpm: number;
    averageTpm: number;
  };
  recentRequests: Array<{
    id: string;
    requestId: string;
    sessionTitle: string | null;
    createdAt: string;
    usage: UsageSummary;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
};

type MeteredPrice = {
  category: "embedding" | "rerank";
  modelId: string;
  modelName: string;
  inputPriceCnyPerMillionTokens: number | null;
  source: "database" | "static" | "unset";
};

type UsageRange = "24h" | "7d" | "30d" | "all";
type ChartMetric = "cost" | "tokens" | "calls";
type ChartMode = "bar" | "area";

const chartColors = [
  "#22d3ee",
  "#34d399",
  "#f59e0b",
  "#a78bfa",
  "#fb7185",
  "#60a5fa",
  "#a3e635",
  "#e879f9",
];

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN");
}

function formatCny(value: number) {
  return `¥${value.toFixed(value >= 10 ? 2 : 4)}`;
}

function categoryMeta(category: UsageSummary["category"]) {
  if (category === "embedding") return { label: "向量模型", icon: Database };
  if (category === "rerank") return { label: "重排模型", icon: BrainCircuit };
  return { label: "对话模型", icon: Bot };
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone: string;
}) {
  return (
    <div className="min-w-0 py-2">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <span className={`flex h-8 w-8 items-center justify-center rounded-full ${tone}`}>
          <Icon className="h-4 w-4" />
        </span>
        <span>{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

function formatChartValue(value: number, metric: ChartMetric) {
  if (metric === "cost") return formatCny(value);
  if (metric === "calls") return `${Math.round(value)} 次`;
  return formatTokens(value);
}

function UsageChart({
  data,
  metric,
  mode,
}: {
  data: UsageResponse;
  metric: ChartMetric;
  mode: ChartMode;
}) {
  const models = data.availableModels
    .filter((model) => data.timeline.some((point) => (point.values[model.id]?.[metric] ?? 0) > 0))
    .map((model, index) => ({ ...model, key: `series_${index}`, color: chartColors[index % chartColors.length] }));
  const chartData = data.timeline.map((point) => ({
    label: point.label,
    ...Object.fromEntries(models.map((model) => [model.key, point.values[model.id]?.[metric] ?? 0])),
  }));
  const formatter = (value: unknown, name: unknown) => {
    const model = models.find((candidate) => candidate.name === String(name));
    return [formatChartValue(Number(value ?? 0), metric), model?.name ?? String(name)];
  };

  if (chartData.length === 0 || models.length === 0) {
    return <div className="flex h-72 items-center justify-center text-sm text-slate-600">当前筛选范围内没有可绘制的数据</div>;
  }

  const common = (
    <>
      <CartesianGrid vertical={false} stroke="#1e293b" />
      <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} minTickGap={24} />
      <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(value) => metric === "cost" ? `¥${Number(value).toFixed(2)}` : formatTokens(Number(value))} width={56} />
      <Tooltip
        cursor={{ fill: "rgba(51, 65, 85, 0.18)" }}
        contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0" }}
        labelStyle={{ color: "#94a3b8", marginBottom: 6 }}
        formatter={formatter}
      />
    </>
  );

  return (
    <div className="h-80 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        {mode === "bar" ? (
          <BarChart data={chartData} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
            {common}
            {models.map((model) => <Bar key={model.key} dataKey={model.key} name={model.name} stackId="usage" fill={model.color} maxBarSize={64} />)}
          </BarChart>
        ) : (
          <AreaChart data={chartData} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
            {common}
            {models.map((model) => <Area key={model.key} type="monotone" dataKey={model.key} name={model.name} stackId="usage" stroke={model.color} fill={model.color} fillOpacity={0.32} />)}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function ModelUsageRow({ usage }: { usage: UsageSummary }) {
  const meta = categoryMeta(usage.category);
  const Icon = meta.icon;
  const sourceLabel = usage.pricingSource === "trace"
    ? "Trace 价格快照"
    : usage.pricingSource === "current"
      ? "按当前配置补算"
        : usage.pricingSource === "static"
        ? "本地参考价"
        : usage.pricingSource === "mixed" ? "混合价格来源" : "未配置价格";

  return (
    <article className="px-4 py-4 sm:px-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,1.4fr)_repeat(4,minmax(90px,.65fr))_minmax(145px,.8fr)] lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-cyan-400" />
            <span className="truncate text-sm font-medium text-slate-100">{usage.modelName}</span>
          </div>
          <div className="mt-1 truncate text-xs text-slate-600">
            {usage.providerName ? `${usage.providerName} · ` : ""}{meta.label} · {usage.model}
          </div>
          <div className={`mt-1 text-[11px] ${usage.pricingConfigured ? "text-slate-600" : "text-amber-500"}`}>{sourceLabel}</div>
        </div>
        {[
          ["调用", `${usage.modelCallCount} 次`],
          ["输入", formatTokens(usage.inputTokens)],
          ["输出", formatTokens(usage.outputTokens)],
          ["缓存命中", `${(usage.cacheHitRate * 100).toFixed(1)}%`],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-[11px] text-slate-600">{label}</div>
            <div className="mt-1 text-sm text-slate-300">{value}</div>
          </div>
        ))}
        <div className="lg:text-right">
          <div className="text-[11px] text-slate-600">估算费用</div>
          {usage.pricingConfigured ? (
            <>
              <div className="mt-1 text-base font-semibold text-slate-100">{formatCny(usage.estimatedCostCny)}</div>
              {usage.cacheSavedCostCny > 0 && <div className="text-[11px] text-emerald-500">缓存节省 {formatCny(usage.cacheSavedCostCny)}</div>}
            </>
          ) : <div className="mt-1 text-sm font-medium text-amber-400">费用未配置</div>}
        </div>
      </div>
      {usage.category === "chat" && usage.pricing && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800/70 pt-2 text-[11px] text-slate-600">
          <span>缓存命中 ¥{usage.pricing.inputCacheHit}/百万</span>
          <span>缓存未命中 ¥{usage.pricing.inputCacheMiss}/百万</span>
          <span>输出 ¥{usage.pricing.output}/百万</span>
        </div>
      )}
      {(usage.category === "embedding" || usage.category === "rerank")
        && typeof usage.inputPriceCnyPerMillionTokens === "number" && (
        <div className="mt-3 border-t border-slate-800/70 pt-2 text-[11px] text-slate-600">
          输入 ¥{usage.inputPriceCnyPerMillionTokens}/百万 Token
        </div>
      )}
    </article>
  );
}

export function UsageCenter() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [range, setRange] = useState<UsageRange>("24h");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("cost");
  const [chartMode, setChartMode] = useState<ChartMode>("bar");
  const [showPricing, setShowPricing] = useState(false);
  const [meteredPrices, setMeteredPrices] = useState<MeteredPrice[]>([]);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const pageSize = 10;
  const selectedModelKey = selectedModels.join(",");

  const load = async (targetPage = page) => {
    if (loadedRef.current) setRequestsLoading(true);
    else setLoading(true);
    setError(null);
    try {
      const search = new URLSearchParams({
        limit: "1000",
        page: String(targetPage),
        pageSize: String(pageSize),
        range,
      });
      if (selectedModels.length > 0) search.set("models", selectedModels.join(","));
      const response = await authFetch(`/api/usage?${search.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "加载用量统计失败");
      setData(payload as UsageResponse);
      loadedRef.current = true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载用量统计失败");
    } finally {
      setLoading(false);
      setRequestsLoading(false);
    }
  };

  useEffect(() => {
    void load(page);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, range, selectedModelKey]);

  useEffect(() => {
    if (
      chartMetric === "cost"
      && data
      && data.total.totalTokens > 0
      && data.total.unpricedTokens / data.total.totalTokens > 0.5
    ) {
      setChartMetric("tokens");
    }
  }, [chartMetric, data]);

  const recent = useMemo(() => data?.recentRequests ?? [], [data?.recentRequests]);
  const chartTotal = useMemo(() => (data?.timeline ?? []).reduce((sum, point) =>
    sum + Object.values(point.values).reduce((pointSum, value) => pointSum + value[chartMetric], 0), 0),
  [chartMetric, data?.timeline]);

  const updateRange = (value: UsageRange) => {
    setPage(1);
    setRange(value);
  };

  const toggleModel = (modelId: string) => {
    setPage(1);
    setSelectedModels((current) => current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId]);
  };

  const loadPricing = async () => {
    setPricingLoading(true);
    setPricingError(null);
    try {
      const response = await authFetch("/api/usage/pricing", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "读取辅助模型价格失败");
      const configured = (payload.prices ?? []) as MeteredPrice[];
      const known = new Set(configured.map((item) => `${item.category}:${item.modelId}`));
      const observed = (data?.availableModels ?? []).flatMap((model) =>
        (model.category === "embedding" || model.category === "rerank")
          && !known.has(`${model.category}:${model.id}`)
          ? [{
              category: model.category,
              modelId: model.id,
              modelName: model.name,
              inputPriceCnyPerMillionTokens: null,
              source: "unset" as const,
            }]
          : []);
      setMeteredPrices([...configured, ...observed]);
    } catch (loadError) {
      setPricingError(loadError instanceof Error ? loadError.message : "读取辅助模型价格失败");
    } finally {
      setPricingLoading(false);
    }
  };

  const openPricing = () => {
    setShowPricing(true);
    void loadPricing();
  };

  const savePricing = async () => {
    setPricingSaving(true);
    setPricingError(null);
    try {
      const response = await authFetch("/api/usage/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prices: meteredPrices.map((item) => ({
          category: item.category,
          modelId: item.modelId,
          inputPriceCnyPerMillionTokens: item.inputPriceCnyPerMillionTokens,
        })) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存辅助模型价格失败");
      await Promise.all([loadPricing(), load()]);
      setShowPricing(false);
    } catch (saveError) {
      setPricingError(saveError instanceof Error ? saveError.message : "保存辅助模型价格失败");
    } finally {
      setPricingSaving(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">用量统计</h2>
            <p className="mt-1 text-sm text-slate-500">按 Trace 中的实际 Token 和模型价格快照分别聚合。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={openPricing} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900">
              <SlidersHorizontal className="h-4 w-4" />价格设置
            </button>
            <select
              value={range}
              onChange={(event) => updateRange(event.target.value as UsageRange)}
              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300 outline-none focus:border-cyan-500"
              aria-label="统计时间范围"
            >
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="all">全部</option>
            </select>
            <details className="relative">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900">
                <Filter className="h-4 w-4" />
                模型{selectedModels.length > 0 ? ` ${selectedModels.length}` : ""}
              </summary>
              <div className="absolute right-0 z-30 mt-2 max-h-72 w-72 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 p-2 shadow-xl shadow-black/40">
                <button type="button" onClick={() => { setSelectedModels([]); setPage(1); }} className="mb-1 w-full rounded px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800">显示全部模型</button>
                {(data?.availableModels ?? []).map((model) => (
                  <label key={model.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs hover:bg-slate-800">
                    <input type="checkbox" checked={selectedModels.includes(model.id)} onChange={() => toggleModel(model.id)} className="h-4 w-4 accent-cyan-500" />
                    <span className="min-w-0 flex-1 truncate text-slate-300">{model.name}</span>
                    <span className="shrink-0 text-slate-600">{categoryMeta(model.category).label}</span>
                  </label>
                ))}
              </div>
            </details>
            <Link href="/?panel=traces" className="inline-flex h-9 items-center rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900">Trace</Link>
            <button type="button" onClick={() => void load()} disabled={loading || requestsLoading} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:bg-slate-900 disabled:opacity-40" title="刷新用量" aria-label="刷新用量">
              <RefreshCw className={`h-4 w-4 ${loading || requestsLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {error && <div className="mt-5 flex items-start gap-2 rounded-md border border-rose-900/70 bg-rose-950/30 px-3 py-2.5 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-slate-500"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载用量统计</div>
        ) : data ? (
          <>
            <section className="grid gap-x-6 gap-y-4 border-b border-slate-800 py-6 sm:grid-cols-2 xl:grid-cols-5">
              <Stat icon={Hash} tone="bg-sky-500/10 text-sky-300" label="总请求" value={data.total.requestCount.toLocaleString("zh-CN")} sub={`${data.total.modelCallCount} 次模型调用`} />
              <Stat icon={Coins} tone="bg-emerald-500/10 text-emerald-300" label="已计价费用" value={formatCny(data.total.estimatedCostCny)} sub={data.total.unpricedTokens > 0 ? `${formatTokens(data.total.unpricedTokens)} Token 尚未计价` : "全部模型均已计价"} />
              <Stat icon={Layers3} tone="bg-fuchsia-500/10 text-fuchsia-300" label="总 Token 数" value={formatTokens(data.total.totalTokens)} sub={`输入 ${formatTokens(data.total.inputTokens)} · 输出 ${formatTokens(data.total.outputTokens)}`} />
              <Stat icon={Gauge} tone="bg-cyan-500/10 text-cyan-300" label="平均 RPM" value={data.analytics.averageRpm.toFixed(data.analytics.averageRpm < 0.1 ? 3 : 2)} sub="每分钟请求数" />
              <Stat icon={Zap} tone="bg-amber-500/10 text-amber-300" label="平均 TPM" value={formatTokens(Math.round(data.analytics.averageTpm))} sub="每分钟 Token 数" />
            </section>

            {data.total.unpricedTokens > 0 && (
              <div className="flex items-start gap-2 border-y border-amber-900/50 bg-amber-950/20 px-3 py-3 text-sm text-amber-300">
                <Coins className="mt-0.5 h-4 w-4 shrink-0" />
                <span>部分模型尚未配置价格，总费用不包含这些模型。对话模型请在“大语言模型”中填写；向量和 Rerank 模型请使用顶部“价格设置”。</span>
              </div>
            )}

            <section className="border-b border-slate-800 py-6">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-slate-200">消耗分布</h3>
                    <span className="text-xs text-slate-500">总计 {formatChartValue(chartTotal, chartMetric)}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">按模型堆叠展示当前时间范围内的用量变化。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border border-slate-700 p-0.5">
                    {([
                      ["cost", "费用"],
                      ["tokens", "Token"],
                      ["calls", "调用"],
                    ] as const).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => setChartMetric(value)} className={`h-7 rounded px-2.5 text-xs ${chartMetric === value ? "bg-slate-700 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}>{label}</button>
                    ))}
                  </div>
                  <div className="inline-flex rounded-md border border-slate-700 p-0.5">
                    <button type="button" onClick={() => setChartMode("bar")} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs ${chartMode === "bar" ? "bg-slate-700 text-slate-100" : "text-slate-500"}`}><BarChart3 className="h-3.5 w-3.5" />柱状</button>
                    <button type="button" onClick={() => setChartMode("area")} className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs ${chartMode === "area" ? "bg-slate-700 text-slate-100" : "text-slate-500"}`}><AreaChartIcon className="h-3.5 w-3.5" />面积</button>
                  </div>
                </div>
              </div>
              <UsageChart data={data} metric={chartMetric} mode={chartMode} />
              <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-slate-500">
                {data.availableModels
                  .filter((model) => data.timeline.some((point) => point.values[model.id]))
                  .map((model, index) => (
                    <span key={model.id} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: chartColors[index % chartColors.length] }} />
                      {model.name}
                    </span>
                  ))}
              </div>
            </section>

            <section className="py-5">
              <h3 className="mb-3 text-sm font-medium text-slate-200">按模型拆分</h3>
              <div className="divide-y divide-slate-800 overflow-hidden rounded-md border border-slate-800 bg-slate-900/20">
                {data.models.length > 0 ? data.models.map((model) => <ModelUsageRow key={model.model} usage={model} />) : <div className="px-4 py-10 text-center text-sm text-slate-500">还没有可统计的模型用量</div>}
              </div>
            </section>

            <section className="border-t border-slate-800 py-5">
              <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-medium text-slate-200">最近请求</h3><span className="text-xs text-slate-600">共 {data.pagination.totalItems} 条</span></div>
              <div className="overflow-x-auto rounded-md border border-slate-800">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="bg-slate-900 text-slate-500"><tr><th className="px-3 py-2 font-medium">时间</th><th className="px-3 py-2 font-medium">会话</th><th className="px-3 py-2 font-medium">主要模型</th><th className="px-3 py-2 text-right font-medium">Tokens</th><th className="px-3 py-2 text-right font-medium">费用</th></tr></thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-950/30">
                    {recent.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-900/50">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{new Date(item.createdAt).toLocaleString("zh-CN")}</td>
                        <td className="max-w-[240px] truncate px-3 py-2 text-slate-400"><Link href={`/?panel=traces&traceId=${encodeURIComponent(item.id)}`} className="hover:text-slate-200">{item.sessionTitle ?? item.requestId}</Link></td>
                        <td className="px-3 py-2 text-slate-500">{item.usage.modelName}</td>
                        <td className="px-3 py-2 text-right text-slate-300">{formatTokens(item.usage.totalTokens)}</td>
                        <td className={`px-3 py-2 text-right ${item.usage.unpricedTokens > 0 ? "text-amber-500" : "text-slate-300"}`}>{item.usage.unpricedTokens > 0 ? "未完整计价" : formatCny(item.usage.estimatedCostCny)}</td>
                      </tr>
                    ))}
                    {recent.length === 0 && <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-500">还没有带 usage 的请求</td></tr>}
                  </tbody>
                </table>
                <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/30 px-3 py-2 text-xs text-slate-500">
                  <span>{requestsLoading ? "加载中..." : `第 ${data.pagination.page} 页`}</span>
                  <div className="flex gap-2">
                    <button type="button" disabled={requestsLoading || !data.pagination.hasPreviousPage} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-md border border-slate-700 px-3 py-1 text-slate-300 disabled:opacity-40">上一页</button>
                    <button type="button" disabled={requestsLoading || !data.pagination.hasNextPage} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-slate-700 px-3 py-1 text-slate-300 disabled:opacity-40">下一页</button>
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
      {showPricing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="metered-pricing-title" className="w-full max-w-2xl rounded-md border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
              <div>
                <h3 id="metered-pricing-title" className="text-base font-semibold text-slate-100">辅助模型价格</h3>
                <p className="mt-1 text-xs text-slate-500">单位统一为人民币 / 百万输入 Token。向量和 Rerank 模型没有输出价格。</p>
              </div>
              <button type="button" onClick={() => setShowPricing(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="关闭" aria-label="关闭价格设置"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
              {pricingLoading ? (
                <div className="flex h-32 items-center justify-center text-sm text-slate-500"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载价格</div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {meteredPrices.map((item, index) => (
                    <div key={`${item.category}:${item.modelId}`} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-end">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {item.category === "embedding" ? <Database className="h-4 w-4 text-cyan-400" /> : <BrainCircuit className="h-4 w-4 text-violet-400" />}
                          <span className="truncate text-sm font-medium text-slate-200">{item.modelName}</span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{item.category === "embedding" ? "向量" : "Rerank"}</span>
                        </div>
                        <div className="mt-1 truncate font-mono text-xs text-slate-600">{item.modelId}</div>
                        {item.source === "static" && <div className="mt-1 text-[11px] text-slate-600">当前显示内置参考价格，保存后转为用户价格。</div>}
                      </div>
                      <label>
                        <span className="mb-1.5 block text-xs text-slate-500">输入价格（¥/百万 Token）</span>
                        <input
                          type="number"
                          min="0"
                          step="0.000001"
                          value={item.inputPriceCnyPerMillionTokens ?? ""}
                          onChange={(event) => setMeteredPrices((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? {
                            ...candidate,
                            inputPriceCnyPerMillionTokens: event.target.value === "" ? null : Number(event.target.value),
                          } : candidate))}
                          placeholder="未配置"
                          className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500"
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {pricingError && <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{pricingError}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
              <button type="button" onClick={() => setShowPricing(false)} className="h-9 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800">取消</button>
              <button type="button" onClick={() => void savePricing()} disabled={pricingLoading || pricingSaving} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40">{pricingSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存价格</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
