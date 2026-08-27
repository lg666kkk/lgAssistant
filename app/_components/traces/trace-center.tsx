"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { TraceDetail } from "./trace-detail";

// 列表页用的 trace 概览（对应 /api/traces 返回的精简字段）
type TraceListItem = {
  id: string;
  request_id: string;
  session_id: string | null;
  session_title: string | null;
  stop_reason: string;
  completed: boolean;
  total_duration_ms: number | null;
  metrics: {
    modelCallCount?: number;
    toolCallCount?: number;
    estimatedTokensSpent?: number;
    actualTotalTokens?: number;
    estimatedModelCostCny?: number;
    totalToolCost?: number;
  };
  created_at: string;
};

// 按 session 分组后的结构
type SessionGroup = {
  sessionId: string | null;
  title: string;
  traces: TraceListItem[];
  latestAt: string; // 组内最新 trace 时间，用于组间排序
};

// stop_reason → 颜色，一眼区分正常完成 / 各类异常退出
function stopReasonClass(reason: string, completed: boolean) {
  if (completed && reason === "completed") return "text-emerald-400";
  if (reason === "max_iterations" || reason === "repeated_tool_call")
    return "text-amber-400";
  if (reason === "token_budget_exceeded") return "text-rose-400";
  return "text-slate-400";
}

// 把平铺的 trace 列表按 session_id 分组，组内按时间倒序，组间按最新 trace 倒序
function groupBySession(traces: TraceListItem[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const t of traces) {
    // session_id 为 null 的（早期未传 sessionId 的请求）归到「无会话」组
    const key = t.session_id ?? "__none__";
    let group = map.get(key);
    if (!group) {
      group = {
        sessionId: t.session_id,
        title: t.session_title || (t.session_id ? "（无标题会话）" : "无会话"),
        traces: [],
        latestAt: t.created_at,
      };
      map.set(key, group);
    }
    group.traces.push(t);
    if (t.created_at > group.latestAt) group.latestAt = t.created_at;
  }
  // 接口已按 created_at 倒序，组内顺序天然正确；组间按最新时间倒序
  return Array.from(map.values()).sort((a, b) =>
    a.latestAt < b.latestAt ? 1 : -1,
  );
}

function SessionBlock({ group, onSelect }: { group: SessionGroup; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-slate-500">{open ? "▼" : "▶"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
          {group.title}
        </span>
        <span className="shrink-0 rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
          {group.traces.length} 条
        </span>
      </button>

      {open && (
        <div className="space-y-1.5 px-3 pb-3">
          {group.traces.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              className="block w-full rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2.5 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-sm font-medium ${stopReasonClass(
                      t.stop_reason,
                      t.completed,
                    )}`}
                  >
                    {t.stop_reason}
                  </span>
                  <span className="ml-2 text-xs text-slate-600">
                    {new Date(t.created_at).toLocaleString("zh-CN")}
                  </span>
                </div>
                <div className="flex shrink-0 gap-3 text-xs text-slate-400">
                  <span title="模型调用次数">🧠 {t.metrics?.modelCallCount ?? 0}</span>
                  <span title="工具调用次数">🔧 {t.metrics?.toolCallCount ?? 0}</span>
                  <span title="真实 token">
                    tok {t.metrics?.actualTotalTokens ?? 0}
                  </span>
                  <span title="估算模型费用">
                    ¥{(t.metrics?.estimatedModelCostCny ?? 0).toFixed(4)}
                  </span>
                  <span title="估算 token">~{t.metrics?.estimatedTokensSpent ?? 0}</span>
                  <span title="总耗时">{t.total_duration_ms ?? "?"}ms</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TraceCenter({ initialTraceId = null }: { initialTraceId?: string | null }) {
  const [traces, setTraces] = useState<TraceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(initialTraceId);

  useEffect(() => {
    authFetch("/api/traces?limit=200")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "加载失败");
        return data;
      })
      .then((data) => setTraces(data.traces))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => groupBySession(traces), [traces]);

  if (selectedTraceId) {
    return <TraceDetail id={selectedTraceId} onBack={() => setSelectedTraceId(null)} />;
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">
              Agent Trace 观测
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              按会话分组，每条是一次 runAgentLoop 的执行轨迹，点击查看逐步明细
            </p>
          </div>
        </div>

        {loading && <div className="text-slate-500">加载中...</div>}
        {error && (
          <div className="rounded-xl border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="rounded-xl border border-slate-800 px-4 py-8 text-center text-slate-500">
            还没有 trace。去对话页发一条消息后再回来。
          </div>
        )}

        <div className="space-y-3">
          {groups.map((g) => (
            <SessionBlock key={g.sessionId ?? "__none__"} group={g} onSelect={setSelectedTraceId} />
          ))}
        </div>
      </div>
    </div>
  );
}
