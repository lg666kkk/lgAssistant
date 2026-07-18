"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/lib/auth/auth-gate";
import { authFetch } from "@/lib/auth/client";

type ConfigGroup = {
  title: string;
  items: Array<{
    key: string;
    label: string;
    value: string | null;
    configured: boolean;
    sensitive: boolean;
  }>;
};

type RuntimeConfigItem = {
  key: string;
  label: string;
  group: string;
  description: string;
  secret: boolean;
  type: "text" | "select";
  options?: string[];
  configured: boolean;
  value: string | null;
  source: "database" | "environment" | "unset";
  updatedAt?: string;
};

export default function SettingsPage() {
  const [configGroups, setConfigGroups] = useState<ConfigGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtimeItems, setRuntimeItems] = useState<RuntimeConfigItem[]>([]);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [canEditRuntime, setCanEditRuntime] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);

  const loadConfig = () => {
    setLoading(true);
    setError(null);
    authFetch("/api/knowledge/config", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载配置失败");
        return data;
      })
      .then((data) => setConfigGroups(data.groups ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

    setRuntimeLoading(true);
    setRuntimeError(null);
    authFetch("/api/settings/runtime-config", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "加载运行时配置失败");
        return data as { canEdit: boolean; items: RuntimeConfigItem[] };
      })
      .then((data) => {
        setCanEditRuntime(data.canEdit);
        setRuntimeItems(data.items);
        setDrafts(Object.fromEntries(
          data.items
            .filter((item) => !item.secret)
            .map((item) => [item.key, item.value ?? ""]),
        ));
      })
      .catch((e) => setRuntimeError(e.message))
      .finally(() => setRuntimeLoading(false));
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const configuredCount = configGroups.reduce(
    (sum, group) => sum + group.items.filter((item) => item.configured).length,
    0,
  );
  const totalCount = configGroups.reduce((sum, group) => sum + group.items.length, 0);
  const runtimeGroups = runtimeItems.reduce<Record<string, RuntimeConfigItem[]>>((groups, item) => {
    (groups[item.group] ??= []).push(item);
    return groups;
  }, {});

  const saveRuntimeConfig = async (item: RuntimeConfigItem) => {
    const value = drafts[item.key]?.trim() ?? "";
    if (!value) {
      setRuntimeNotice(item.secret ? "请输入新的密钥后再保存" : "配置值不能为空");
      return;
    }
    setSavingKey(item.key);
    setRuntimeNotice(null);
    try {
      const response = await authFetch("/api/settings/runtime-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: item.key, value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存运行时配置失败");
      setRuntimeNotice(`${item.label} 已加密保存。业务链路接入该配置后会在缓存刷新时读取新值。`);
      if (item.secret) setDrafts((current) => ({ ...current, [item.key]: "" }));
      loadConfig();
    } catch (saveError) {
      setRuntimeNotice(saveError instanceof Error ? saveError.message : "保存运行时配置失败");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <AuthGate>
    <div className="h-screen overflow-y-auto bg-zinc-950 text-zinc-200">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-zinc-500 hover:text-zinc-200">
            返回对话
          </Link>
          <Link href="/knowledge" className="text-zinc-500 hover:text-zinc-200">
            知识库
          </Link>
        </div>

        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">设置</h1>
            <p className="mt-1 text-sm text-zinc-500">
              知识库、数据库、模型和表结构的当前运行配置。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={loadConfig}
              disabled={loading}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
            >
              刷新
            </button>
            <div className="text-sm text-zinc-500">
              {configuredCount}/{totalCount} 已配置
            </div>
          </div>
        </div>

        {loading && <div className="mt-8 text-zinc-500">加载中...</div>}
        {error && (
          <div className="mt-8 rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {configGroups.map((group) => (
              <section key={group.title} className="rounded-lg border border-zinc-800 bg-zinc-950">
                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                  <h2 className="text-sm font-medium text-zinc-100">{group.title}</h2>
                  <div className="text-xs text-zinc-500">
                    {group.items.filter((item) => item.configured).length}/{group.items.length}
                  </div>
                </div>
                <div className="space-y-2 p-3">
                  {group.items.map((item) => (
                    <div key={item.key} className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-zinc-300">{item.label}</div>
                          <div className="mt-1 truncate font-mono text-xs text-zinc-600">{item.key}</div>
                        </div>
                        <span
                          className={
                            item.configured
                              ? "rounded bg-emerald-950 px-2 py-0.5 text-xs text-emerald-300"
                              : "rounded bg-rose-950 px-2 py-0.5 text-xs text-rose-300"
                          }
                        >
                          {item.configured ? "已配置" : "缺失"}
                        </span>
                      </div>
                      <div className="mt-3 break-all rounded bg-zinc-950 px-2 py-2 font-mono text-xs text-zinc-300">
                        {item.value ?? "-"}
                      </div>
                      {item.sensitive && (
                        <div className="mt-2 text-xs text-zinc-600">
                          敏感配置已脱敏，仅展示首尾片段。
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <section className="mt-8 border-t border-zinc-800 pt-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">运行时配置</h2>
              <p className="mt-1 text-sm text-zinc-500">
                动态配置保存到 Supabase；敏感值加密存储且不会回显。
              </p>
            </div>
            <span className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-500">
              {canEditRuntime ? "配置管理员" : "只读"}
            </span>
          </div>

          {runtimeLoading && <div className="mt-4 text-sm text-zinc-500">加载运行时配置...</div>}
          {runtimeError && (
            <div className="mt-4 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
              {runtimeError}
            </div>
          )}
          {runtimeNotice && (
            <div className="mt-4 rounded border border-sky-900 bg-sky-950/30 px-3 py-2 text-sm text-sky-300">
              {runtimeNotice}
            </div>
          )}

          {!runtimeLoading && !runtimeError && (
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {Object.entries(runtimeGroups).map(([group, items]) => (
                <section key={group} className="border border-zinc-800 bg-zinc-950">
                  <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200">{group}</h3>
                  <div className="space-y-4 p-4">
                    {items.map((item) => (
                      <div key={item.key} className="border-b border-zinc-900 pb-4 last:border-0 last:pb-0">
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor={`runtime-${item.key}`} className="text-sm text-zinc-200">{item.label}</label>
                          <span className="text-xs text-zinc-600">
                            {item.configured ? `已配置 (${item.source})` : "未配置"}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-600">{item.description}</p>
                        {item.type === "select" ? (
                          <select
                            id={`runtime-${item.key}`}
                            value={drafts[item.key] ?? ""}
                            disabled={!canEditRuntime}
                            onChange={(event) => setDrafts((current) => ({ ...current, [item.key]: event.target.value }))}
                            className="mt-2 w-full border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 disabled:opacity-50"
                          >
                            {item.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        ) : (
                          <input
                            id={`runtime-${item.key}`}
                            type={item.secret ? "password" : "text"}
                            value={drafts[item.key] ?? ""}
                            placeholder={item.secret && item.configured ? "已配置；输入新值以覆盖" : "请输入配置值"}
                            disabled={!canEditRuntime}
                            onChange={(event) => setDrafts((current) => ({ ...current, [item.key]: event.target.value }))}
                            className="mt-2 w-full border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 disabled:opacity-50"
                          />
                        )}
                        {canEditRuntime && (
                          <button
                            type="button"
                            onClick={() => void saveRuntimeConfig(item)}
                            disabled={savingKey === item.key}
                            className="mt-2 border border-sky-800 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-50"
                          >
                            {savingKey === item.key ? "保存中..." : "保存"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
    </AuthGate>
  );
}
