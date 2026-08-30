"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  BrainCircuit,
  Check,
  Database,
  FileSearch,
  KeyRound,
  LoaderCircle,
  Save,
  Server,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import type {
  EmbeddingProviderId,
  UserEmbeddingConfigView,
} from "@/lib/embedding-config/types";

type Draft = {
  provider: EmbeddingProviderId;
  baseUrl: string;
  apiKey: string;
};

type TestState = {
  tone: "testing" | "ok" | "error";
  text: string;
};

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500 disabled:cursor-not-allowed disabled:text-slate-500";

const emptyConfig: UserEmbeddingConfigView = {
  provider: "dashscope",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyConfigured: false,
  apiKeyHint: "",
  modelId: "text-embedding-v4",
  dimensions: 1024,
  configured: false,
  indexHealth: {
    knowledgeVectors: 0,
    compatibleKnowledgeVectors: 0,
    memoryVectors: 0,
    compatibleMemoryVectors: 0,
    hasUnknownVersion: false,
  },
};

function statusLabel(config: UserEmbeddingConfigView) {
  if (!config.configured) return { text: "未配置", className: "bg-amber-950/60 text-amber-300" };
  if (config.lastTestStatus === "error") return { text: "连接异常", className: "bg-rose-950/60 text-rose-300" };
  if (config.lastTestStatus === "ok") return { text: "连接正常", className: "bg-emerald-950/60 text-emerald-300" };
  return { text: "已配置", className: "bg-sky-950/60 text-sky-300" };
}

function IndexMetric({
  icon: Icon,
  title,
  total,
  compatible,
}: {
  icon: typeof Database;
  title: string;
  total: number;
  compatible: number;
}) {
  const healthy = total === compatible;
  const empty = total === 0;
  return (
    <article className="rounded-md border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-200">
          <Icon className="h-4 w-4 shrink-0 text-cyan-400" />
          <span>{title}</span>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${
          empty
            ? "bg-slate-800 text-slate-400"
            : healthy ? "bg-emerald-950/50 text-emerald-300" : "bg-amber-950/50 text-amber-300"
        }`}>
          {empty ? "暂无数据" : healthy ? "版本完整" : "版本未知"}
        </span>
      </div>
      <div className="mt-4 text-2xl font-semibold text-slate-100">{total.toLocaleString("zh-CN")}</div>
      <div className="mt-1 text-xs text-slate-500">
        {healthy
          ? `已记录当前版本 ${compatible.toLocaleString("zh-CN")} 条`
          : `已记录 ${compatible.toLocaleString("zh-CN")} 条，未标记 ${(total - compatible).toLocaleString("zh-CN")} 条`}
      </div>
    </article>
  );
}

export function EmbeddingCenter() {
  const [config, setConfig] = useState<UserEmbeddingConfigView | null>(null);
  const [draft, setDraft] = useState<Draft>({
    provider: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState | null>(null);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/embedding/config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取向量嵌入配置失败");
      const next = data as UserEmbeddingConfigView;
      setConfig(next);
      setDraft({ provider: next.provider, baseUrl: next.baseUrl, apiKey: "" });
    } catch (loadError) {
      setConfig(emptyConfig);
      setError(loadError instanceof Error ? loadError.message : "读取向量嵌入配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/embedding/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存向量嵌入配置失败");
      await loadConfig();
      setNotice("配置已加密保存，记忆与知识库 RAG 将共同使用这套连接");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存向量嵌入配置失败");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTestState({ tone: "testing", text: "正在生成测试向量..." });
    setError(null);
    try {
      const response = await authFetch("/api/embedding/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接测试失败");
      setTestState({
        tone: "ok",
        text: `连接成功 · ${data.modelId} · ${data.dimensions} 维 · ${data.latencyMs} ms`,
      });
      if (config?.configured && !draft.apiKey) await loadConfig();
    } catch (testError) {
      setTestState({
        tone: "error",
        text: testError instanceof Error ? testError.message : "连接测试失败",
      });
    }
  };

  const status = config ? statusLabel(config) : null;
  const unknownMemoryVectors = config
    ? Math.max(0, config.indexHealth.memoryVectors - config.indexHealth.compatibleMemoryVectors)
    : 0;
  const unknownKnowledgeVectors = config
    ? Math.max(0, config.indexHealth.knowledgeVectors - config.indexHealth.compatibleKnowledgeVectors)
    : 0;
  const unknownVersionSummary = [
    unknownMemoryVectors > 0 ? `${unknownMemoryVectors.toLocaleString("zh-CN")} 条旧记忆` : "",
    unknownKnowledgeVectors > 0 ? `${unknownKnowledgeVectors.toLocaleString("zh-CN")} 个知识库 Chunk` : "",
  ].filter(Boolean).join("、");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-slate-100">向量嵌入</h2>
              {status && <span className={`rounded px-2 py-0.5 text-xs ${status.className}`}>{status.text}</span>}
            </div>
            <p className="mt-1 text-sm text-slate-500">为记忆和知识库 RAG 生成内容向量与查询向量。</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              API Key 使用服务器主密钥加密，浏览器不会读取或回显明文。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || !draft.baseUrl.trim() || (!config?.apiKeyConfigured && !draft.apiKey.trim())}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存配置
          </button>
        </div>

        {(error || notice) && (
          <div className={`mt-5 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
            error
              ? "border-rose-900/70 bg-rose-950/30 text-rose-300"
              : "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"
          }`}>
            {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error ?? notice}</span>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-slate-500">
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载向量嵌入配置
          </div>
        ) : config ? (
          <>
            <section className="grid gap-4 py-5 md:grid-cols-2">
              <IndexMetric
                icon={BrainCircuit}
                title="语义记忆"
                total={config.indexHealth.memoryVectors}
                compatible={config.indexHealth.compatibleMemoryVectors}
              />
              <IndexMetric
                icon={FileSearch}
                title="知识库 Chunk"
                total={config.indexHealth.knowledgeVectors}
                compatible={config.indexHealth.compatibleKnowledgeVectors}
              />
            </section>

            {config.indexHealth.hasUnknownVersion && (
              <div className="flex items-start gap-2 border-y border-amber-900/50 bg-amber-950/20 px-3 py-3 text-sm text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{unknownVersionSummary}缺少向量版本标识，当前仍可正常使用；后续更新时会自动补全。</span>
              </div>
            )}

            <section className="border-t border-slate-800 py-5">
              <div className="mb-4">
                <h3 className="text-sm font-medium text-slate-200">连接配置</h3>
                <p className="mt-1 text-xs text-slate-500">当前只开放与现有 pgvector 索引兼容的模型和维度。</p>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">Provider</span>
                  <select
                    value={draft.provider}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      provider: event.target.value as EmbeddingProviderId,
                      baseUrl: event.target.value === "dashscope"
                        ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
                        : current.baseUrl,
                    }))}
                    className={inputClass}
                  >
                    <option value="dashscope">阿里云 DashScope</option>
                    <option value="openai-compatible">OpenAI 兼容服务</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">Base URL</span>
                  <div className="relative">
                    <Server className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                    <input
                      value={draft.baseUrl}
                      onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                      className={`${inputClass} pl-9`}
                      placeholder="https://.../compatible-mode/v1"
                    />
                  </div>
                </label>
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">API Key（留空保持原值）</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.apiKey}
                      onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                      className={`${inputClass} pl-9`}
                      placeholder={config.apiKeyConfigured ? `已加密保存 ${config.apiKeyHint}` : "输入 API Key"}
                    />
                  </div>
                </label>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-3">
                  <div className="text-xs text-slate-500">模型</div>
                  <div className="mt-1 truncate font-mono text-sm text-slate-200">{config.modelId}</div>
                </div>
                <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-3">
                  <div className="text-xs text-slate-500">维度</div>
                  <div className="mt-1 font-mono text-sm text-slate-200">{config.dimensions}</div>
                </div>
                <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-3">
                  <div className="text-xs text-slate-500">用途</div>
                  <div className="mt-1 text-sm text-slate-200">记忆 + RAG</div>
                </div>
                <div className="rounded-md border border-slate-800 bg-slate-900/40 px-3 py-3">
                  <div className="text-xs text-slate-500">最近测试</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {config.lastTestedAt ? new Date(config.lastTestedAt).toLocaleString() : "尚未测试"}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void testConnection()}
                  disabled={testState?.tone === "testing" || (!draft.apiKey.trim() && !config.apiKeyConfigured)}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {testState?.tone === "testing" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  测试连接
                </button>
                {testState && (
                  <div className={`flex items-center gap-2 text-sm ${
                    testState.tone === "ok"
                      ? "text-emerald-300"
                      : testState.tone === "error" ? "text-rose-300" : "text-slate-400"
                  }`}>
                    {testState.tone === "ok" && <Check className="h-4 w-4" />}
                    {testState.tone === "error" && <AlertCircle className="h-4 w-4" />}
                    {testState.text}
                  </div>
                )}
              </div>
            </section>

            <div className="border-t border-slate-800 pt-4 text-xs leading-5 text-slate-600">
              模型或维度变化会使历史向量失效。完成版本化重建能力前，模型固定为 text-embedding-v4，维度固定为 1024。
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
