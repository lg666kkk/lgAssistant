"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Zap,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import type { UserMemoryConfigView } from "@/lib/memory-config/types";

type MemoryRow = {
  id: string;
  key: string;
  content: string;
  memory_type: string;
  source: string;
  confidence: number;
  importance: number;
  status: string;
  evidence?: unknown;
  created_at: string;
  updated_at: string;
  valid_from: string;
  valid_to: string | null;
  last_accessed_at: string | null;
  version: number;
};

type HistoryRow = {
  id: string;
  key: string;
  content: string;
  memory_type: string;
  source: string;
  confidence: number;
  importance: number;
  status: string;
  recorded_at: string;
  superseded_at: string;
  effective_from: string;
  effective_to: string;
  version: number;
  supersede_kind: string;
  reason?: string;
};

type MemoryData = {
  summary: {
    total: number;
    active: number;
    invalidated: number;
    conflicted: number;
    historyVersions: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
  };
  memories: MemoryRow[];
  history: HistoryRow[];
};

const inputClass = "h-9 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500";
const typeLabels: Record<string, string> = {
  preference: "偏好",
  fact: "事实",
  profile: "画像",
  project: "项目",
  correction: "更正",
  episodic: "情景",
};
const sourceLabels: Record<string, string> = {
  user_explicit: "用户明确",
  inferred: "系统推断",
  tool: "工具",
};

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

function NumberField({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} className={inputClass} />
    </label>
  );
}

export function MemoryCenter() {
  const [config, setConfig] = useState<UserMemoryConfigView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"settings" | "data">("settings");
  const [view, setView] = useState<"current" | "history">("current");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResponse, dataResponse] = await Promise.all([
        authFetch("/api/memory/config", { cache: "no-store" }),
        authFetch("/api/memory/data", { cache: "no-store" }),
      ]);
      const [configPayload, dataPayload] = await Promise.all([configResponse.json(), dataResponse.json()]);
      if (!configResponse.ok) throw new Error(configPayload.error || "读取记忆配置失败");
      if (!dataResponse.ok) throw new Error(dataPayload.error || "读取记忆数据失败");
      setConfig(configPayload as UserMemoryConfigView);
      setData(dataPayload as MemoryData);
      setApiKey("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载记忆面板失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const patchConfig = (patch: Partial<UserMemoryConfigView>) => {
    setConfig((current) => current ? { ...current, ...patch } : current);
    setNotice(null);
  };
  const patchRerank = (patch: Partial<UserMemoryConfigView["rerank"]>) => {
    setConfig((current) => current ? { ...current, rerank: { ...current.rerank, ...patch } } : current);
    setNotice(null);
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/memory/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, apiKey: apiKey || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存记忆配置失败");
      await load();
      setNotice("记忆设置已保存，下一次聊天请求立即使用新配置。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存记忆配置失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!config) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await authFetch("/api/memory/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: config.rerank.url, apiKey: apiKey || undefined, model: config.rerank.model }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "连接测试失败");
      setTestResult({ ok: true, text: `连接成功 · ${payload.latencyMs} ms · ${payload.resultCount} 个分数` });
    } catch (testError) {
      setTestResult({ ok: false, text: testError instanceof Error ? testError.message : "连接测试失败" });
    } finally {
      setTesting(false);
    }
  };

  const deleteMemory = async (row: MemoryRow) => {
    const confirmed = window.confirm(
      `确定永久删除记忆“${row.key}”吗？\n\n当前记忆、语义向量和全部历史版本都会被删除，且无法恢复。`,
    );
    if (!confirmed) return;
    setDeletingId(row.id);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/memory/data/${row.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "删除记忆失败");
      await load();
      setExpandedId(null);
      setNotice(`记忆 ${row.key} 已永久删除，不会再被当前召回或历史工具检索。`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除记忆失败");
    } finally {
      setDeletingId(null);
    }
  };

  const rows = useMemo(() => {
    const source = view === "current" ? data?.memories ?? [] : data?.history ?? [];
    const normalized = query.trim().toLowerCase();
    return source.filter((row) => {
      const matchesQuery = !normalized || `${row.key} ${row.content}`.toLowerCase().includes(normalized);
      const matchesType = typeFilter === "all" || row.memory_type === typeFilter;
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      return matchesQuery && matchesType && matchesStatus;
    });
  }, [data, query, statusFilter, typeFilter, view]);

  const maxTypeCount = Math.max(1, ...Object.values(data?.summary.byType ?? {}));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">记忆清单</h2>
            <p className="mt-1 text-sm text-slate-500">管理当前用户的记忆策略，并查看系统保存的长期记忆。</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新
          </button>
        </div>

        {(error || notice) && (
          <div className={`mt-5 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${error ? "border-rose-900/70 bg-rose-950/30 text-rose-300" : "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"}`}>
            {error ? <AlertCircle className="mt-0.5 h-4 w-4" /> : <Check className="mt-0.5 h-4 w-4" />}
            <span>{error ?? notice}</span>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-slate-500"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载记忆数据</div>
        ) : config && data ? (
          <>
            <nav aria-label="记忆清单视图" className="mt-5 flex border-b border-slate-800">
              <button
                type="button"
                onClick={() => setActiveTab("settings")}
                className={`flex h-10 items-center gap-2 border-b-2 px-4 text-sm ${activeTab === "settings" ? "border-cyan-400 text-cyan-200" : "border-transparent text-slate-500 hover:text-slate-300"}`}
              >
                <SlidersHorizontal className="h-4 w-4" />记忆设置
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("data")}
                className={`flex h-10 items-center gap-2 border-b-2 px-4 text-sm ${activeTab === "data" ? "border-cyan-400 text-cyan-200" : "border-transparent text-slate-500 hover:text-slate-300"}`}
              >
                <Brain className="h-4 w-4" />记忆数据
              </button>
            </nav>
            {activeTab === "settings" ? (
            <section className="py-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200"><SlidersHorizontal className="h-4 w-4 text-cyan-400" />记忆设置</h3>
                  <p className="mt-1 text-xs text-slate-500">召回和写入参数按当前用户隔离，密钥不会回显。</p>
                </div>
                <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40">
                  {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存设置
                </button>
              </div>

              <label className="mb-4 flex items-center justify-between gap-4 rounded-md border border-slate-800 bg-slate-900/20 px-4 py-3">
                <div><div className="text-sm font-medium text-slate-200">启用长期记忆</div><div className="mt-1 text-xs text-slate-500">未启用时不召回、不调用记忆工具，也不抽取或固化新记忆。</div></div>
                <input type="checkbox" checked={config.enabled} onChange={(event) => patchConfig({ enabled: event.target.checked })} className="h-4 w-4 accent-cyan-500" />
              </label>

              <div className="grid gap-4 border-y border-slate-800 py-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField label="召回数量" value={config.recallLimit} min={1} max={10} step={1} onChange={(value) => patchConfig({ recallLimit: value })} />
                <NumberField label="召回阈值" value={config.recallThreshold} min={0} max={1} step={0.01} onChange={(value) => patchConfig({ recallThreshold: value })} />
                <NumberField label="写入置信度" value={config.writeConfidence} min={0} max={1} step={0.01} onChange={(value) => patchConfig({ writeConfidence: value })} />
                <NumberField label="含糊候选阈值" value={config.ambiguousCandidateThreshold} min={0} max={1} step={0.01} onChange={(value) => patchConfig({ ambiguousCandidateThreshold: value })} />
                <NumberField label="关键词准入阈值" value={config.keywordAdmitThreshold} min={0} max={1} step={0.01} onChange={(value) => patchConfig({ keywordAdmitThreshold: value })} />
                <label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-400">融合策略</span><select value={config.fusionStrategy} onChange={(event) => patchConfig({ fusionStrategy: event.target.value as UserMemoryConfigView["fusionStrategy"] })} className={inputClass}><option value="weighted">Weighted</option><option value="rrf">RRF</option><option value="vector_only">仅向量</option></select></label>
              </div>

              <div className="mt-4 border-b border-slate-800 pb-4">
                <label className="flex items-center justify-between gap-4 rounded-md border border-slate-800 bg-slate-900/20 px-4 py-3">
                  <div><div className="text-sm font-medium text-slate-200">Qwen3 模型重排</div><div className="mt-1 text-xs text-slate-500">对宽候选池进行语义精排；失败时自动回退规则排序。</div></div>
                  <input type="checkbox" checked={config.rerank.enabled} onChange={(event) => patchRerank({ enabled: event.target.checked })} className="h-4 w-4 accent-cyan-500" />
                </label>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label><span className="mb-1.5 block text-xs font-medium text-slate-400">Rerank URL</span><input value={config.rerank.url} onChange={(event) => patchRerank({ url: event.target.value })} className={inputClass} placeholder="https://.../reranks" /></label>
                  <label><span className="mb-1.5 block text-xs font-medium text-slate-400">API Key（留空保持原值）</span><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-600" /><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className={`${inputClass} pl-9`} placeholder={config.rerank.apiKeyConfigured ? `已配置 ${config.rerank.apiKeyHint}` : "输入 API Key"} /></div></label>
                  <label><span className="mb-1.5 block text-xs font-medium text-slate-400">模型</span><input value={config.rerank.model} onChange={(event) => patchRerank({ model: event.target.value })} className={inputClass} /></label>
                  <label><span className="mb-1.5 block text-xs font-medium text-slate-400">模式</span><select value={config.rerank.mode} onChange={(event) => patchRerank({ mode: event.target.value as "always" | "conditional" })} className={inputClass}><option value="always">Always</option><option value="conditional">Conditional</option></select></label>
                  <NumberField label="候选数量" value={config.rerank.candidateCount} min={2} max={24} step={1} onChange={(value) => patchRerank({ candidateCount: value })} />
                  <NumberField label="超时（ms）" value={config.rerank.timeoutMs} min={200} max={8000} step={100} onChange={(value) => patchRerank({ timeoutMs: value })} />
                  <label><span className="mb-1.5 block text-xs font-medium text-slate-400">准入阈值（留空回退规则）</span><input type="number" min="0" max="1" step="0.01" value={config.rerank.admitThreshold ?? ""} onChange={(event) => patchRerank({ admitThreshold: event.target.value === "" ? undefined : Number(event.target.value) })} className={inputClass} /></label>
                  <label className="md:col-span-2">
                    <span className="mb-1.5 block text-xs font-medium text-slate-400">任务指令</span>
                    <textarea
                      value={config.rerank.instruct}
                      onChange={(event) => patchRerank({ instruct: event.target.value })}
                      rows={4}
                      className="min-h-24 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm leading-6 text-slate-100 outline-none transition focus:border-cyan-500"
                    />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void test()} disabled={testing || (!apiKey && !config.rerank.apiKeyConfigured)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-900 disabled:opacity-40">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}测试连接</button>
                  {testResult && <span className={`text-xs ${testResult.ok ? "text-emerald-300" : "text-rose-300"}`}>{testResult.text}</span>}
                </div>
              </div>
            </section>
            ) : (
            <section className="border-t border-slate-800 py-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><h3 className="flex items-center gap-2 text-sm font-medium text-slate-200"><Brain className="h-4 w-4 text-cyan-400" />记忆数据</h3><p className="mt-1 text-xs text-slate-500">展示当前权威记忆和被取代的历史版本。</p></div>
                <div className="flex rounded-md border border-slate-700 p-0.5 text-xs"><button onClick={() => setView("current")} className={`h-7 px-3 ${view === "current" ? "bg-slate-800 text-white" : "text-slate-500"}`}>当前记忆</button><button onClick={() => setView("history")} className={`h-7 px-3 ${view === "history" ? "bg-slate-800 text-white" : "text-slate-500"}`}>历史版本</button></div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-800 bg-slate-800 sm:grid-cols-5">
                {[['总记忆', data.summary.total], ['有效', data.summary.active], ['已失效', data.summary.invalidated], ['冲突', data.summary.conflicted], ['历史版本', data.summary.historyVersions]].map(([label, value]) => <div key={String(label)} className="bg-slate-950 px-4 py-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-lg font-semibold text-slate-200">{value}</div></div>)}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(data.summary.byType).map(([type, count]) => <div key={type} className="flex items-center gap-3 text-xs"><span className="w-12 text-slate-500">{typeLabels[type] ?? type}</span><div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800"><div className="h-full bg-cyan-500" style={{ width: `${(count / maxTypeCount) * 100}%` }} /></div><span className="w-6 text-right text-slate-400">{count}</span></div>)}
              </div>

              <div className="mt-5 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_160px]">
                <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-600" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 key 或记忆内容" className={`${inputClass} pl-9`} /></div>
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className={inputClass}><option value="all">全部类型</option>{Object.keys(typeLabels).map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}</select>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={inputClass}><option value="all">全部状态</option><option value="active">有效</option><option value="invalidated">已失效</option><option value="conflicted">冲突</option></select>
              </div>

              <div className="mt-3 divide-y divide-slate-800 border-y border-slate-800">
                {rows.map((row) => {
                  const expanded = expandedId === String(row.id);
                  return (
                    <div key={String(row.id)} className="py-3">
                      <div className="flex items-start gap-2">
                        <button type="button" onClick={() => setExpandedId(expanded ? null : String(row.id))} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                          <span className="mt-0.5 text-slate-600">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs text-cyan-300">{row.key}</span>
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{typeLabels[row.memory_type] ?? row.memory_type}</span>
                              <span className={`text-[10px] ${row.status === "active" ? "text-emerald-300" : row.status === "conflicted" ? "text-amber-300" : "text-slate-500"}`}>{row.status}</span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm text-slate-300">{row.content}</p>
                          </div>
                          <span className="shrink-0 text-[10px] text-slate-600">v{row.version}</span>
                        </button>
                        {view === "current" && (
                          <button
                            type="button"
                            onClick={() => void deleteMemory(row as MemoryRow)}
                            disabled={deletingId === String(row.id)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-rose-950/40 hover:text-rose-300 disabled:opacity-40"
                            title="永久删除记忆"
                            aria-label={`永久删除记忆 ${row.key}`}
                          >
                            {deletingId === String(row.id) ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          </button>
                        )}
                      </div>
                      {expanded && (
                        <div className="ml-7 mt-3 grid gap-2 rounded-md bg-slate-900/30 p-3 text-xs text-slate-500 sm:grid-cols-2">
                          <div>来源：{sourceLabels[row.source] ?? row.source}</div>
                          <div>置信度：{Number(row.confidence).toFixed(2)}</div>
                          <div>重要性：{Number(row.importance).toFixed(2)}</div>
                          <div>更新时间：{formatTime("updated_at" in row ? row.updated_at : row.superseded_at)}</div>
                          {"last_accessed_at" in row && <div>最后召回：{formatTime(row.last_accessed_at)}</div>}
                          {"supersede_kind" in row && <div>变更类型：{row.supersede_kind}</div>}
                          {"reason" in row && row.reason && <div className="sm:col-span-2">原因：{row.reason}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {rows.length === 0 && <div className="py-10 text-center text-sm text-slate-500">没有符合条件的记忆</div>}
              </div>
            </section>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
