"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Save,
  Search,
  Server,
  Zap,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import type {
  SearchProviderId,
  UserSearchCatalog,
} from "@/lib/search/types";

type DraftProvider = UserSearchCatalog["providers"][number] & {
  apiKey: string;
};

type TestState = {
  status: "testing" | "ok" | "error";
  message: string;
};

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500";

export function SearchEngineCenter() {
  const [providers, setProviders] = useState<DraftProvider[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<SearchProviderId>("tavily");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Partial<Record<SearchProviderId, TestState>>>({});

  const loadCatalog = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/search/providers", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取搜索引擎配置失败");
      const catalog = data as UserSearchCatalog;
      setProviders(catalog.providers.map((provider) => ({ ...provider, apiKey: "" })));
      setDefaultProvider(catalog.defaultProvider);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取搜索引擎配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCatalog();
  }, []);

  const updateProvider = (id: SearchProviderId, patch: Partial<DraftProvider>) => {
    setProviders((current) => current.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider));
    setNotice(null);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await authFetch("/api/search/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultProvider,
          providers: providers.map((provider) => ({
            id: provider.id,
            apiKey: provider.apiKey || undefined,
            enabled: provider.enabled,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存搜索引擎配置失败");
      await loadCatalog();
      setNotice("搜索引擎配置已保存，后续联网搜索将使用新的默认服务");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存搜索引擎配置失败");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (provider: DraftProvider) => {
    setTestStates((current) => ({
      ...current,
      [provider.id]: { status: "testing", message: "正在测试连接..." },
    }));
    try {
      const response = await authFetch(`/api/search/providers/${provider.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: provider.apiKey || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接测试失败");
      setTestStates((current) => ({
        ...current,
        [provider.id]: {
          status: "ok",
          message: `连接成功 · ${data.latencyMs} ms · 返回 ${data.resultCount} 条`,
        },
      }));
    } catch (testError) {
      setTestStates((current) => ({
        ...current,
        [provider.id]: {
          status: "error",
          message: testError instanceof Error ? testError.message : "连接测试失败",
        },
      }));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">搜索引擎</h2>
            <p className="mt-1 text-sm text-slate-500">配置联网搜索工具使用的服务和用户级 API Key。</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <Server className="h-4 w-4 shrink-0" />
              API Key 使用服务器主密钥加密，浏览器不会读取或回显明文。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || providers.length === 0}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
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
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载搜索引擎配置
          </div>
        ) : (
          <>
            <section className="py-5">
              <div className="mb-3">
                <h3 className="text-sm font-medium text-slate-200">默认搜索引擎</h3>
                <p className="mt-1 text-xs text-slate-500">联网搜索工具每次会使用这里选择的服务。</p>
              </div>
              <select
                value={defaultProvider}
                onChange={(event) => setDefaultProvider(event.target.value as SearchProviderId)}
                className={`${inputClass} max-w-md`}
                aria-label="默认搜索引擎"
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id} disabled={!provider.enabled}>
                    {provider.name}{provider.enabled ? "" : "（未启用）"}
                  </option>
                ))}
              </select>
            </section>

            <section className="grid gap-4 border-t border-slate-800 py-5 lg:grid-cols-3">
              {providers.map((provider) => (
                <article key={provider.id} className={`rounded-lg border p-4 ${
                  defaultProvider === provider.id
                    ? "border-cyan-500/60 bg-cyan-500/5"
                    : "border-slate-800 bg-slate-900/30"
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-cyan-300">
                        <Search className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="font-medium text-slate-100">{provider.name}</h3>
                        <span className={`text-xs ${provider.apiKeyConfigured ? "text-emerald-400" : "text-slate-600"}`}>
                          {provider.apiKeyConfigured
                            ? provider.source === "environment"
                              ? "已配置 · 服务器后备"
                              : `已配置 ${provider.apiKeyHint}`
                            : "尚未配置"}
                        </span>
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-1.5 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={provider.enabled}
                        onChange={(event) => updateProvider(provider.id, { enabled: event.target.checked })}
                        className="accent-cyan-500"
                      />
                      启用
                    </label>
                  </div>

                  <p className="mt-3 min-h-12 text-xs leading-5 text-slate-500">{provider.description}</p>

                  <label className="mt-4 block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-400">
                      API Key（留空保持原值）
                    </span>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={provider.apiKey}
                        onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
                        placeholder={provider.apiKeyConfigured ? "已加密保存" : "输入 API Key"}
                        className={`${inputClass} pl-9`}
                        aria-label={`${provider.name} API Key`}
                      />
                    </div>
                  </label>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDefaultProvider(provider.id);
                          if (!provider.enabled) updateProvider(provider.id, { enabled: true });
                        }}
                        className={`h-8 rounded-md border px-2.5 text-xs ${
                          defaultProvider === provider.id
                            ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-200"
                            : "border-slate-700 text-slate-400 hover:bg-slate-800"
                        }`}
                      >
                        {defaultProvider === provider.id ? "当前默认" : "设为默认"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void testConnection(provider)}
                        disabled={testStates[provider.id]?.status === "testing" || (!provider.apiKey.trim() && !provider.apiKeyConfigured)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {testStates[provider.id]?.status === "testing"
                          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          : <Zap className="h-3.5 w-3.5" />}
                        测试连接
                      </button>
                    </div>
                    <a
                      href={provider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
                    >
                      官方文档 <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  {testStates[provider.id] && (
                    <div className={`mt-3 rounded-md border px-2.5 py-2 text-xs ${
                      testStates[provider.id]?.status === "ok"
                        ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-300"
                        : testStates[provider.id]?.status === "error"
                          ? "border-rose-900/60 bg-rose-950/20 text-rose-300"
                          : "border-slate-800 bg-slate-950/50 text-slate-400"
                    }`}>
                      {testStates[provider.id]?.message}
                    </div>
                  )}
                </article>
              ))}
            </section>

            <div className="border-t border-slate-800 pt-4 text-xs leading-5 text-slate-600">
              常见的其他选择还有 Google Programmable Search、Bing Web Search、Serper、SerpAPI、Parallel 和 You.com。
              当前先集成三种互补方案，避免配置项过多。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
