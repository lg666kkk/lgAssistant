"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  ListFilter,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import type {
  LlmReasoningMode,
  UserLlmCatalog,
  UserLlmModelDraft,
  UserLlmPreferences,
  UserLlmProvider,
} from "@/lib/llm/types";

type Props = {
  catalog: UserLlmCatalog | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
};

type ProviderDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: UserLlmModelDraft[];
};

type DiscoveredModel = {
  id: string;
  ownedBy?: string;
};

const presets = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1-mini" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "openai/gpt-4.1-mini" },
  { name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", modelId: "moonshot-v1-8k" },
];

function createModel(modelId = "") : UserLlmModelDraft {
  return {
    modelId,
    displayName: modelId,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    temperature: 0.7,
    supportsTools: true,
    supportsImages: false,
    reasoningMode: "none",
    enabled: true,
  };
}

function createDiscoveredModel(modelId: string): UserLlmModelDraft {
  return {
    ...createModel(modelId),
    supportsImages: false,
    reasoningMode: "none",
  };
}

function createDraft(preset?: typeof presets[number]): ProviderDraft {
  return {
    name: preset?.name ?? "",
    baseUrl: preset?.baseUrl ?? "",
    apiKey: "",
    enabled: true,
    models: [createModel(preset?.modelId)],
  };
}

function providerToDraft(provider: UserLlmProvider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    enabled: provider.enabled,
    models: provider.models.map((model) => ({
      id: model.id,
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      temperature: model.temperature,
      supportsTools: model.supportsTools,
      supportsImages: model.supportsImages,
      reasoningMode: model.reasoningMode,
      enabled: model.enabled,
    })),
  };
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-500 disabled:text-slate-500";
const modelInputClass = "h-9 w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 px-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-500 disabled:text-slate-500";

export function LanguageModelCenter({ catalog, loading, error, onRefresh }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [preferences, setPreferences] = useState<UserLlmPreferences>({
    defaultModelId: null,
    fastModelId: null,
    visionModelId: null,
  });
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[] | null>(null);
  const [discoverySearch, setDiscoverySearch] = useState("");
  const [selectedDiscoveredIds, setSelectedDiscoveredIds] = useState<string[]>([]);

  const providers = useMemo(() => catalog?.providers ?? [], [catalog?.providers]);
  const enabledModels = useMemo(
    () => (catalog?.models ?? []).filter((model) => model.enabled),
    [catalog?.models],
  );
  const filteredDiscoveredModels = useMemo(() => {
    const query = discoverySearch.trim().toLowerCase();
    return (discoveredModels ?? []).filter((model) =>
      !query || `${model.id} ${model.ownedBy ?? ""}`.toLowerCase().includes(query));
  }, [discoveredModels, discoverySearch]);

  useEffect(() => {
    setPreferences(catalog?.preferences ?? {
      defaultModelId: null,
      fastModelId: null,
      visionModelId: null,
    });
  }, [catalog?.preferences]);

  useEffect(() => {
    if (draft || providers.length === 0) return;
    const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
    setSelectedId(selected.id);
    setDraft(providerToDraft(selected));
  }, [draft, providers, selectedId]);

  const selectProvider = (provider: UserLlmProvider) => {
    setSelectedId(provider.id);
    setDraft(providerToDraft(provider));
    setNotice(null);
    setDiscoveredModels(null);
    setSelectedDiscoveredIds([]);
  };

  const startNew = (preset?: typeof presets[number]) => {
    setSelectedId(null);
    setDraft(createDraft(preset));
    setNotice(null);
    setDiscoveredModels(null);
    setSelectedDiscoveredIds([]);
  };

  const updateModel = (index: number, patch: Partial<UserLlmModelDraft>) => {
    setDraft((current) => current ? {
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, ...patch } : model),
    } : current);
  };

  const saveProvider = async () => {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await authFetch(
        draft.id ? `/api/llm/providers/${draft.id}` : "/api/llm/providers",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            adapterType: "openai-compatible",
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey || undefined,
            enabled: draft.enabled,
            models: draft.models,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      const nextId = draft.id ?? data.providerId;
      await onRefresh();
      setSelectedId(nextId);
      setDraft(null);
      setNotice({ tone: "ok", text: "Provider 和模型配置已加密保存" });
    } catch (saveError) {
      setNotice({ tone: "error", text: saveError instanceof Error ? saveError.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!draft?.id) {
      setNotice({ tone: "error", text: "请先保存 Provider，再执行连接测试" });
      return;
    }
    const model = draft.models.find((candidate) => candidate.enabled && candidate.id);
    if (!model?.id) {
      setNotice({ tone: "error", text: "请先保存至少一个启用模型" });
      return;
    }
    setTesting(true);
    setNotice(null);
    try {
      const response = await authFetch(`/api/llm/providers/${draft.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: model.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接测试失败");
      setNotice({ tone: "ok", text: `连接成功，响应耗时 ${data.latencyMs} ms` });
    } catch (testError) {
      setNotice({ tone: "error", text: testError instanceof Error ? testError.message : "连接测试失败" });
    } finally {
      setTesting(false);
    }
  };

  const discoverModels = async () => {
    if (!draft) return;
    if (!draft.baseUrl.trim()) {
      setNotice({ tone: "error", text: "请先填写 Base URL" });
      return;
    }
    if (!draft.id && !draft.apiKey.trim()) {
      setNotice({ tone: "error", text: "新 Provider 需要先填写 API Key" });
      return;
    }
    setDiscovering(true);
    setNotice(null);
    try {
      const response = await authFetch("/api/llm/models/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: draft.id,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "获取模型列表失败");
      const models = (data.models ?? []) as DiscoveredModel[];
      setDiscoveredModels(models);
      setDiscoverySearch("");
      setSelectedDiscoveredIds([]);
      setNotice({ tone: "ok", text: `获取到 ${models.length} 个模型，请选择需要添加的模型` });
    } catch (discoverError) {
      setDiscoveredModels(null);
      setNotice({
        tone: "error",
        text: discoverError instanceof Error ? discoverError.message : "获取模型列表失败",
      });
    } finally {
      setDiscovering(false);
    }
  };

  const addDiscoveredModels = () => {
    if (!draft || selectedDiscoveredIds.length === 0) return;
    const existingIds = new Set(draft.models.map((model) => model.modelId.trim()).filter(Boolean));
    const additions = selectedDiscoveredIds
      .filter((modelId) => !existingIds.has(modelId))
      .map(createDiscoveredModel);
    const retained = draft.models.filter((model) => model.modelId.trim());
    setDraft({ ...draft, models: [...retained, ...additions] });
    setSelectedDiscoveredIds([]);
    setNotice({
      tone: "ok",
      text: additions.length > 0
        ? `已加入 ${additions.length} 个模型，请确认能力和上下文参数后保存`
        : "所选模型已经在当前列表中",
    });
  };

  const deleteProvider = async () => {
    if (!draft?.id || !window.confirm(`确定删除 Provider“${draft.name}”及其全部模型吗？`)) return;
    setDeleting(true);
    setNotice(null);
    try {
      const response = await authFetch(`/api/llm/providers/${draft.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      setDraft(null);
      setSelectedId(null);
      await onRefresh();
      setNotice({ tone: "ok", text: "Provider 已删除" });
    } catch (deleteError) {
      setNotice({ tone: "error", text: deleteError instanceof Error ? deleteError.message : "删除失败" });
    } finally {
      setDeleting(false);
    }
  };

  const savePreferences = async () => {
    setSavingPreferences(true);
    setNotice(null);
    try {
      const response = await authFetch("/api/llm/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存路由失败");
      await onRefresh();
      setNotice({ tone: "ok", text: "模型路由已保存" });
    } catch (preferenceError) {
      setNotice({ tone: "error", text: preferenceError instanceof Error ? preferenceError.message : "保存路由失败" });
    } finally {
      setSavingPreferences(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">大语言模型</h2>
            <p className="mt-1 text-sm text-slate-500">配置用户级 API 密钥、兼容接口和模型能力。</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <Server className="h-4 w-4 shrink-0" />
              API Key 使用服务器主密钥加密，浏览器不会读取或回显明文。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={loading}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            刷新
          </button>
        </div>

        <section className="border-b border-slate-800 py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-slate-200">Provider</h3>
            <button
              type="button"
              onClick={() => startNew()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-3 text-sm font-medium text-slate-950 hover:bg-cyan-400"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              自定义 Provider
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => selectProvider(provider)}
                className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition ${
                  selectedId === provider.id
                    ? "border-cyan-500 bg-cyan-500/10 text-cyan-200"
                    : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${provider.enabled ? "bg-emerald-400" : "bg-slate-600"}`} />
                {provider.name}
                <span className="text-xs text-slate-500">{provider.models.length}</span>
              </button>
            ))}
            {providers.length === 0 && !loading && (
              <span className="text-sm text-slate-500">尚未配置 Provider</span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => startNew(preset)}
                className="h-8 rounded-md border border-slate-800 px-3 text-xs text-slate-500 hover:border-slate-700 hover:text-slate-300"
              >
                + {preset.name}
              </button>
            ))}
          </div>
        </section>

        {(error || notice) && (
          <div className={`mt-5 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
            error || notice?.tone === "error"
              ? "border-rose-900/70 bg-rose-950/30 text-rose-300"
              : "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"
          }`}>
            {error || notice?.tone === "error"
              ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error ?? notice?.text}</span>
          </div>
        )}

        {loading && !catalog ? (
          <div className="flex h-64 items-center justify-center text-slate-500">
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载模型配置
          </div>
        ) : draft ? (
          <section className="py-5">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Provider 名称">
                <input className={inputClass} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 DeepSeek" />
              </FormField>
              <FormField label="协议">
                <div className="flex h-10 items-center rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300">OpenAI-compatible</div>
              </FormField>
              <div className="md:col-span-2">
                <FormField label="Base URL">
                  <input className={inputClass} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
                </FormField>
              </div>
              <FormField label={draft.id ? "API Key（留空保持原值）" : "API Key"}>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                  <input type="password" autoComplete="new-password" className={`${inputClass} pl-9`} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.id ? "已加密保存" : "sk-..."} />
                </div>
              </FormField>
              <label className="flex h-10 items-center gap-3 self-end rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-300">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 accent-cyan-500" />
                启用此 Provider
              </label>
            </div>

            <div className="mt-5 border-t border-slate-800 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-slate-200">模型</h3>
                  <p className="mt-1 text-xs text-slate-500">能力开关决定工具和图片是否允许进入请求。</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void discoverModels()} disabled={discovering} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-900 disabled:opacity-50">
                    {discovering ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ListFilter className="h-3.5 w-3.5" />}
                    获取模型列表
                  </button>
                  <button type="button" onClick={() => setDraft({ ...draft, models: [...draft.models, createModel()] })} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-900">
                    <Plus className="h-3.5 w-3.5" />手动添加
                  </button>
                </div>
              </div>
              {discoveredModels && (
                <div className="mt-4 border-y border-slate-800 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={discoverySearch}
                      onChange={(event) => setDiscoverySearch(event.target.value)}
                      placeholder="搜索模型 ID"
                      className={`${inputClass} min-w-56 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => setSelectedDiscoveredIds(
                        filteredDiscoveredModels.every((model) => selectedDiscoveredIds.includes(model.id))
                          ? selectedDiscoveredIds.filter((id) => !filteredDiscoveredModels.some((model) => model.id === id))
                          : Array.from(new Set([...selectedDiscoveredIds, ...filteredDiscoveredModels.map((model) => model.id)])),
                      )}
                      className="h-10 rounded-md border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-900"
                    >
                      {filteredDiscoveredModels.length > 0
                        && filteredDiscoveredModels.every((model) => selectedDiscoveredIds.includes(model.id))
                        ? "取消当前选择"
                        : "选择当前结果"}
                    </button>
                    <button
                      type="button"
                      onClick={addDiscoveredModels}
                      disabled={selectedDiscoveredIds.length === 0}
                      className="h-10 rounded-md bg-cyan-500 px-3 text-xs font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
                    >
                      添加已选（{selectedDiscoveredIds.length}）
                    </button>
                    <button type="button" onClick={() => setDiscoveredModels(null)} className="flex h-10 w-10 items-center justify-center rounded-md text-slate-500 hover:bg-slate-900 hover:text-slate-300" title="关闭模型列表">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 max-h-64 overflow-y-auto border-t border-slate-800 pt-2">
                    {filteredDiscoveredModels.map((model) => {
                      const checked = selectedDiscoveredIds.includes(model.id);
                      const alreadyAdded = draft.models.some((candidate) => candidate.modelId === model.id);
                      return (
                        <label key={model.id} className="flex min-h-9 cursor-pointer items-center gap-3 px-2 text-sm hover:bg-slate-900/70">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={alreadyAdded}
                            onChange={(event) => setSelectedDiscoveredIds((current) =>
                              event.target.checked
                                ? [...current, model.id]
                                : current.filter((id) => id !== model.id))}
                            className="h-4 w-4 accent-cyan-500"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{model.id}</span>
                          {model.ownedBy && <span className="shrink-0 text-xs text-slate-600">{model.ownedBy}</span>}
                          {alreadyAdded && <span className="shrink-0 text-xs text-emerald-400">已添加</span>}
                        </label>
                      );
                    })}
                    {filteredDiscoveredModels.length === 0 && (
                      <div className="py-8 text-center text-sm text-slate-500">没有匹配的模型</div>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-3 divide-y divide-slate-800 border-y border-slate-800">
                {draft.models.map((model, index) => (
                  <div key={model.id ?? index} className="py-2.5">
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] xl:grid-cols-[1.2fr_1.2fr_.7fr_.7fr_auto]">
                      <input className={modelInputClass} value={model.modelId} onChange={(event) => updateModel(index, { modelId: event.target.value, displayName: model.displayName || event.target.value })} placeholder="模型 ID" aria-label="模型 ID" />
                      <input className={modelInputClass} value={model.displayName} onChange={(event) => updateModel(index, { displayName: event.target.value })} placeholder="显示名称" aria-label="显示名称" />
                      <input type="number" className={modelInputClass} value={model.contextWindow} onChange={(event) => updateModel(index, { contextWindow: Number(event.target.value) })} title="上下文窗口" aria-label="上下文窗口" />
                      <input type="number" className={modelInputClass} value={model.maxOutputTokens} onChange={(event) => updateModel(index, { maxOutputTokens: Number(event.target.value) })} title="最大输出 Token" aria-label="最大输出 Token" />
                      <button type="button" disabled={draft.models.length <= 1} onClick={() => setDraft({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })} className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-rose-950/40 hover:text-rose-300 disabled:opacity-30 md:col-start-3 md:row-start-1 xl:col-start-5" title="删除模型" aria-label="删除模型">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-400">
                      <label className="flex h-7 items-center gap-1.5"><input type="checkbox" checked={model.enabled} onChange={(event) => updateModel(index, { enabled: event.target.checked })} className="accent-cyan-500" />启用</label>
                      <label className="flex h-7 items-center gap-1.5"><input type="checkbox" checked={model.supportsTools} onChange={(event) => updateModel(index, { supportsTools: event.target.checked })} className="accent-cyan-500" />工具调用</label>
                      <label className="flex h-7 items-center gap-1.5"><input type="checkbox" checked={model.supportsImages} onChange={(event) => updateModel(index, { supportsImages: event.target.checked })} className="accent-cyan-500" />图片输入</label>
                      <label className="flex h-7 items-center gap-1.5">
                        Reasoning
                        <select value={model.reasoningMode} onChange={(event) => updateModel(index, { reasoningMode: event.target.value as LlmReasoningMode })} className="h-7 rounded-md border border-slate-700 bg-slate-950 px-2 text-slate-300">
                          <option value="none">关闭</option>
                          <option value="deepseek">DeepSeek reasoning_content</option>
                        </select>
                      </label>
                      <label className="flex h-7 items-center gap-1.5">
                        Temp
                        <input type="number" min="0" max="2" step="0.1" value={model.temperature} onChange={(event) => updateModel(index, { temperature: Number(event.target.value) })} className="h-7 w-16 rounded-md border border-slate-700 bg-slate-950 px-2 text-slate-300 outline-none transition focus:border-cyan-500" aria-label="Temperature" />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
              <div className="flex gap-2">
                {draft.id && (
                  <button type="button" onClick={() => void testConnection()} disabled={testing || saving} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50">
                    {testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    测试连接
                  </button>
                )}
                {draft.id && (
                  <button type="button" onClick={() => void deleteProvider()} disabled={deleting || saving} className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-900/60 px-3 text-sm text-rose-300 hover:bg-rose-950/30 disabled:opacity-50">
                    <Trash2 className="h-4 w-4" />删除
                  </button>
                )}
              </div>
              <button type="button" onClick={() => void saveProvider()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存 Provider
              </button>
            </div>
          </section>
        ) : (
          <div className="flex h-52 flex-col items-center justify-center border-b border-slate-800 text-slate-500">
            <Unplug className="mb-3 h-7 w-7" />
            <p className="text-sm">选择 Provider，或从模板创建一个新配置</p>
          </div>
        )}

        <section className="border-t border-slate-800 py-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-slate-200">模型路由</h3>
              <p className="mt-1 text-xs text-slate-500">为聊天、后台快速任务和图片请求选择默认模型。</p>
            </div>
            <button type="button" onClick={() => void savePreferences()} disabled={savingPreferences || enabledModels.length === 0} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-40">
              {savingPreferences ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存路由
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {([
              ["defaultModelId", "默认聊天模型", "普通对话的初始模型，聊天时仍可手动切换。", enabledModels],
              ["fastModelId", "快速任务模型", "用于记忆处理、知识画像和 Wiki 编译等后台任务，适合低延迟、低成本模型。", enabledModels],
              ["visionModelId", "视觉模型", "上传图片时自动选用，只显示支持图片输入的模型。", enabledModels.filter((model) => model.supportsImages)],
            ] as const).map(([key, label, description, options]) => (
              <label key={key} className="block min-w-0">
                <span className="block text-xs font-medium text-slate-400">{label}</span>
                <span className="mb-2 mt-1 block min-h-8 text-xs leading-4 text-slate-600">{description}</span>
                <select className={inputClass} value={preferences[key] ?? ""} onChange={(event) => setPreferences({ ...preferences, [key]: event.target.value || null })}>
                  <option value="">自动选择</option>
                  {options.map((model) => <option key={model.id} value={model.id}>{model.providerName} / {model.displayName}</option>)}
                </select>
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
