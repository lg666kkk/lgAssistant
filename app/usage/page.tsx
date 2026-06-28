"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/lib/auth/auth-gate";
import { authFetch } from "@/lib/auth/client";

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

type UsageRequest = {
  id: string;
  requestId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  model: string;
  createdAt: string;
  totalDurationMs: number | null;
  usage: UsageSummary;
};

type UsageResponse = {
  total: UsageSummary;
  models: UsageSummary[];
  recentRequests: UsageRequest[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalTraceCount: number | null;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
};

type DeepSeekBalanceInfo = {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
};

type DeepSeekBalanceResponse = {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
};

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-CN");
}

function formatCny(value: number) {
  return `¥${value.toFixed(value >= 10 ? 2 : 4)}`;
}

function formatBalance(info?: DeepSeekBalanceInfo, key?: keyof DeepSeekBalanceInfo) {
  if (!info || !key) return "--";
  const prefix = info.currency === "CNY" ? "¥" : `${info.currency} `;
  return `${prefix}${info[key]}`;
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

function TokenBar({ usage }: { usage: UsageSummary }) {
  const total = Math.max(usage.totalTokens, 1);
  const hit = (usage.cacheHitTokens / total) * 100;
  const creation = (usage.cacheCreationTokens / total) * 100;
  const miss = (Math.max(0, usage.cacheMissTokens - usage.cacheCreationTokens) / total) * 100;
  const output = (usage.outputTokens / total) * 100;

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-800">
        <div className="bg-emerald-500" style={{ width: `${hit}%` }} />
        <div className="bg-amber-500" style={{ width: `${creation}%` }} />
        <div className="bg-sky-500" style={{ width: `${miss}%` }} />
        <div className="bg-violet-500" style={{ width: `${output}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>缓存读取 {formatTokens(usage.cacheHitTokens)}</span>
        <span>缓存创建 {formatTokens(usage.cacheCreationTokens)}</span>
        <span>普通输入 {formatTokens(usage.cacheMissTokens)}</span>
        <span>输出 {formatTokens(usage.outputTokens)}</span>
      </div>
    </div>
  );
}

function ModelRow({ model }: { model: UsageSummary }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium text-slate-100">{model.modelName}</div>
          <div className="mt-1 text-xs text-slate-600">{model.model}</div>
        </div>
        <div className="text-right">
          <div className="font-semibold text-slate-100">
            {formatCny(model.estimatedCostCny)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {model.requestCount} 请求 · {model.modelCallCount} 调用
          </div>
        </div>
      </div>
      <div className="mt-3">
        <TokenBar usage={model} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 sm:grid-cols-4">
        <span>总量 {formatTokens(model.totalTokens)}</span>
        <span>输入 {formatTokens(model.inputTokens)}</span>
        <span>输出 {formatTokens(model.outputTokens)}</span>
        <span>命中率 {(model.cacheHitRate * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [balance, setBalance] = useState<DeepSeekBalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    const isInitialLoad = !data;
    if (isInitialLoad) {
      setLoading(true);
    } else {
      setRequestsLoading(true);
    }

    authFetch(`/api/usage?limit=1000&page=${page}&pageSize=${pageSize}`)
      .then(async (r) => {
        const payload = await r.json();
        if (!r.ok) throw new Error(payload.error || "加载失败");
        return payload;
      })
      .then((payload) => setData(payload))
      .catch((e) => setError(e.message))
      .finally(() => {
        setLoading(false);
        setRequestsLoading(false);
      });
  }, [page]);

  useEffect(() => {
    authFetch("/api/deepseek/balance")
      .then(async (r) => {
        const payload = await r.json();
        if (!r.ok) throw new Error(payload.error || "余额加载失败");
        return payload;
      })
      .then((payload) => setBalance(payload))
      .catch((e) => setBalanceError(e.message));
  }, []);

  const recent = useMemo(() => data?.recentRequests ?? [], [data]);
  const primaryBalance = balance?.balance_infos?.[0];

  return (
    <AuthGate>
    <div className="h-screen overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">
              模型用量与费用
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              基于 trace 中的真实 usage 聚合，费用按本地模型价格表估算
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/traces"
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
            >
              Trace
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
            >
              返回对话
            </Link>
          </div>
        </div>

        {loading && <div className="text-slate-500">加载中...</div>}
        {error && (
          <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-3 md:grid-cols-5">
              <Stat
                label="DeepSeek 余额"
                value={formatBalance(primaryBalance, "total_balance")}
                sub={
                  balanceError
                    ? balanceError
                    : primaryBalance
                      ? `充值 ${formatBalance(
                          primaryBalance,
                          "topped_up_balance",
                        )} · 赠送 ${formatBalance(
                          primaryBalance,
                          "granted_balance",
                        )} · ${balance?.is_available ? "可用" : "不可用"}`
                      : "加载中"
                }
              />
              <Stat label="估算总费用" value={formatCny(data.total.estimatedCostCny)} />
              <Stat label="真实总 tokens" value={formatTokens(data.total.totalTokens)} />
              <Stat
                label="缓存命中率"
                value={`${(data.total.cacheHitRate * 100).toFixed(1)}%`}
                sub={`${formatTokens(data.total.cacheHitTokens)} 命中`}
              />
              <Stat
                label="模型调用"
                value={String(data.total.modelCallCount)}
                sub={`${data.total.requestCount} 个请求`}
              />
            </div>

            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-slate-100">总量构成</h2>
                <span className="text-xs text-slate-600">
                  输入 {formatTokens(data.total.inputTokens)} · 输出{" "}
                  {formatTokens(data.total.outputTokens)}
                </span>
              </div>
              <TokenBar usage={data.total} />
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.25fr]">
              <section>
                <h2 className="mb-3 text-sm font-medium text-slate-100">
                  按模型拆分
                </h2>
                <div className="space-y-3">
                  {data.models.length === 0 ? (
                    <div className="rounded-lg border border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
                      还没有可统计的模型 usage。
                    </div>
                  ) : (
                    data.models.map((model) => (
                      <ModelRow key={model.model} model={model} />
                    ))
                  )}
                </div>
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-slate-100">
                    最近请求
                  </h2>
                  {data.pagination.totalItems > 0 && (
                    <span className="text-xs text-slate-600">
                      第 {(data.pagination.page - 1) * data.pagination.pageSize + 1}
                      -
                      {Math.min(
                        data.pagination.page * data.pagination.pageSize,
                        data.pagination.totalItems,
                      )}{" "}
                      条 / 共 {data.pagination.totalItems} 条
                    </span>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">时间</th>
                        <th className="px-3 py-2 font-medium">会话</th>
                        <th className="px-3 py-2 font-medium">模型</th>
                        <th className="px-3 py-2 text-right font-medium">Tokens</th>
                        <th className="px-3 py-2 text-right font-medium">费用</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-950/30">
                      {recent.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-900/50">
                          <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                            {new Date(item.createdAt).toLocaleString("zh-CN")}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2 text-slate-400">
                            <Link
                              href={`/traces/${item.id}`}
                              className="hover:text-slate-200"
                            >
                              {item.sessionTitle ?? item.requestId}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-slate-500">
                            {item.model}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-300">
                            {formatTokens(item.usage.totalTokens)}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-300">
                            {formatCny(item.usage.estimatedCostCny)}
                          </td>
                        </tr>
                      ))}
                      {recent.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-3 py-8 text-center text-slate-500"
                          >
                            还没有带真实 usage 的请求。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/30 px-3 py-2 text-xs text-slate-500">
                    <span>
                      {requestsLoading
                        ? "加载中..."
                        : `第 ${data.pagination.page} 页`}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={
                          requestsLoading || !data.pagination.hasPreviousPage
                        }
                        onClick={() => setPage((value) => Math.max(1, value - 1))}
                        className="rounded-md border border-slate-700 px-3 py-1 text-slate-300 disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-slate-800"
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        disabled={requestsLoading || !data.pagination.hasNextPage}
                        onClick={() => setPage((value) => value + 1)}
                        className="rounded-md border border-slate-700 px-3 py-1 text-slate-300 disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-slate-800"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
    </AuthGate>
  );
}
