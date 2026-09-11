"use client";

import { useAuth } from "@web/lib/auth/use-auth";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  KeyRound,
  LoaderCircle,
  Save,
  TestTubeDiagonal,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import type { UserNotionConnectionView } from "@/lib/knowledge/connections/types";

const inputClass = "h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-700 disabled:opacity-50";

export function NotionConnectionPanel({
  onConfigChange,
}: {
  onConfigChange?: (config: UserNotionConnectionView) => void;
}) {
  const { user } = useAuth();
  const [config, setConfig] = useState<UserNotionConnectionView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [defaultRecursive, setDefaultRecursive] = useState(true);
  const [maxDepth, setMaxDepth] = useState(8);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const applyConfig = useCallback((next: UserNotionConnectionView) => {
    setConfig(next);
    setEnabled(next.enabled);
    setDefaultRecursive(next.defaultRecursive);
    setMaxDepth(next.maxDepth);
    setToken("");
    onConfigChange?.(next);
  }, [onConfigChange]);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/knowledge/connections/notion", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "读取 Notion 配置失败");
      applyConfig(payload as UserNotionConnectionView);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取 Notion 配置失败");
    } finally {
      setLoading(false);
    }
  }, [applyConfig, user]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/knowledge/connections/notion", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          token: token || undefined,
          defaultRecursive,
          maxDepth,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存 Notion 配置失败");
      applyConfig(payload as UserNotionConnectionView);
      setNotice("Notion 配置已加密保存，下一次同步立即使用。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存 Notion 配置失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await authFetch("/api/knowledge/connections/notion/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Notion 连接测试失败");
      setTestResult({
        ok: true,
        text: `连接成功 · ${payload.latencyMs} ms · ${payload.integrationName}`,
      });
    } catch (testError) {
      setTestResult({
        ok: false,
        text: testError instanceof Error ? testError.message : "Notion 连接测试失败",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Notion 连接</h2>
          <p className="mt-1 text-xs text-zinc-500">配置仅属于当前用户，Integration Token 不会回显。</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => { setEnabled(event.target.checked); setNotice(null); }}
            disabled={Boolean(user) && (loading || saving)}
            className="h-4 w-4 accent-cyan-600"
          />
          启用
        </label>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
          <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载 Notion 配置
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {(error || notice) && (
            <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${error ? "border-rose-900 bg-rose-950/30 text-rose-300" : "border-emerald-900 bg-emerald-950/20 text-emerald-300"}`}>
              {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{error ?? notice}</span>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <KeyRound className="h-4 w-4" />Integration Token
              </span>
              <input
                type="password"
                value={token}
                onChange={(event) => { setToken(event.target.value); setNotice(null); setTestResult(null); }}
                placeholder={config?.tokenConfigured ? `已配置 ${config.tokenHint}，留空保持不变` : "secret_... 或 ntn_..."}
                autoComplete="new-password"
                className={inputClass}
                disabled={Boolean(user) && (saving || testing)}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">最大递归深度</span>
              <input
                type="number"
                value={maxDepth}
                min={1}
                max={16}
                step={1}
                onChange={(event) => setMaxDepth(Number(event.target.value))}
                className={inputClass}
                disabled={Boolean(user) && (saving || testing)}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={defaultRecursive}
                onChange={(event) => setDefaultRecursive(event.target.checked)}
                disabled={Boolean(user) && (saving || testing)}
                className="h-4 w-4 accent-cyan-600"
              />
              新同步默认递归子页面
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void test()}
                disabled={Boolean(user) && (testing || saving || (!token && !config?.tokenConfigured))}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                {testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <TestTubeDiagonal className="h-4 w-4" />}
                测试连接
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={Boolean(user) && (saving || testing)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
              >
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存配置
              </button>
            </div>
          </div>

          {testResult && (
            <div className={`rounded-md border px-3 py-2 text-sm ${testResult.ok ? "border-emerald-900 bg-emerald-950/20 text-emerald-300" : "border-rose-900 bg-rose-950/30 text-rose-300"}`}>
              {testResult.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
