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

export default function SettingsPage() {
  const [configGroups, setConfigGroups] = useState<ConfigGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const configuredCount = configGroups.reduce(
    (sum, group) => sum + group.items.filter((item) => item.configured).length,
    0,
  );
  const totalCount = configGroups.reduce((sum, group) => sum + group.items.length, 0);

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
      </div>
    </div>
    </AuthGate>
  );
}
