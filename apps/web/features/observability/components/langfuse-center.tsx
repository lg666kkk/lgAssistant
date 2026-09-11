"use client";

import { useAuth } from "@web/lib/auth/use-auth";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Save,
  Server,
  Zap,
} from "lucide-react";
import { authFetch } from "@web/lib/auth/client";

type LangfuseConfigResponse = {
  enabled: boolean;
  baseUrl: string;
  publicKeyConfigured: boolean;
  publicKeyHint: string;
  secretKeyConfigured: boolean;
  secretKeyHint: string;
  updatedAt?: string;
};

const inputClass = "h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500 disabled:opacity-50";

export function LangfuseCenter() {
  const { user } = useAuth();
  const [config, setConfig] = useState<LangfuseConfigResponse | null>(user ? null : { enabled: false, baseUrl: "", publicKeyConfigured: false, publicKeyHint: "", secretKeyConfigured: false, secretKeyHint: "" });
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://cloud.langfuse.com");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/langfuse/config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取 Langfuse 配置失败");
      const next = data as LangfuseConfigResponse;
      setConfig(next);
      setEnabled(next.enabled);
      setBaseUrl(next.baseUrl);
      setPublicKey("");
      setSecretKey("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取 Langfuse 配置失败");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/langfuse/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          baseUrl,
          publicKey: publicKey || undefined,
          secretKey: secretKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存 Langfuse 配置失败");
      await load();
      setNotice("Langfuse 配置已加密保存，下一次请求立即使用当前用户的新配置。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存 Langfuse 配置失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await authFetch("/api/langfuse/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          publicKey: publicKey || undefined,
          secretKey: secretKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Langfuse 连接测试失败");
      setTestResult({
        tone: "ok",
        text: `连接成功 · ${data.latencyMs} ms${typeof data.projectCount === "number" ? ` · ${data.projectCount} 个项目` : ""}`,
      });
    } catch (testError) {
      setTestResult({
        tone: "error",
        text: testError instanceof Error ? testError.message : "Langfuse 连接测试失败",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">Langfuse 配置</h2>
            <p className="mt-1 text-sm text-slate-500">配置外部 LLM Trace、Span 和在线评分的观测出口。</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <Server className="h-4 w-4 shrink-0" />
              密钥使用服务器主密钥加密；配置仅属于当前登录用户。
            </div>
          </div>
          <a
            href="https://cloud.langfuse.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900"
          >
            打开 Langfuse <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        {(error || notice) && (
          <div className={`mt-5 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
            error
              ? "border-rose-900/70 bg-rose-950/30 text-rose-300"
              : "border-amber-900/70 bg-amber-950/20 text-amber-300"
          }`}>
            {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <RotateCcw className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error ?? notice}</span>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-slate-500">
            <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载 Langfuse 配置
          </div>
        ) : config ? (
          <>
            <section className="grid gap-3 py-5 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="text-xs text-slate-500">配置状态</div>
                <div className={`mt-2 text-sm font-medium ${enabled ? "text-emerald-300" : "text-slate-400"}`}>
                  {!user ? "登录后查看" : enabled ? "已启用" : "未启用"}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="text-xs text-slate-500">Public Key</div>
                <div className={`mt-2 text-sm font-medium ${config.publicKeyConfigured ? "text-emerald-300" : "text-slate-500"}`}>
                  {!user ? "—" : config.publicKeyConfigured ? config.publicKeyHint : "未配置"}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-4">
                <div className="text-xs text-slate-500">Secret Key</div>
                <div className={`mt-2 text-sm font-medium ${config.secretKeyConfigured ? "text-emerald-300" : "text-slate-500"}`}>
                  {!user ? "—" : config.secretKeyConfigured ? config.secretKeyHint : "未配置"}
                </div>
              </div>
            </section>

            <section className="space-y-5 border-t border-slate-800 py-5">
              <label className="flex items-center justify-between gap-4 rounded-md border border-slate-800 bg-slate-900/20 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-slate-200">启用 Langfuse</div>
                  <div className="mt-1 text-xs text-slate-500">关闭后，当前用户的新请求不再向 Langfuse 上报。</div>
                </div>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  className="h-4 w-4 accent-cyan-500"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-400">Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className={inputClass}
                  placeholder="https://cloud.langfuse.com"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">Public Key（留空保持原值）</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={publicKey}
                      onChange={(event) => setPublicKey(event.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder={config.publicKeyConfigured ? "已加密保存" : "pk-lf-..."}
                    />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">Secret Key（留空保持原值）</span>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={secretKey}
                      onChange={(event) => setSecretKey(event.target.value)}
                      className={`${inputClass} pl-9`}
                      placeholder={config.secretKeyConfigured ? "已加密保存" : "sk-lf-..."}
                    />
                  </div>
                </label>
              </div>

              {testResult && (
                <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
                  testResult.tone === "ok"
                    ? "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"
                    : "border-rose-900/70 bg-rose-950/20 text-rose-300"
                }`}>
                  {testResult.tone === "ok" ? <Check className="mt-0.5 h-4 w-4" /> : <AlertCircle className="mt-0.5 h-4 w-4" />}
                  <span>{testResult.text}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <Activity className="h-4 w-4" />
                  连接测试不会写入 Trace；保存后下一次请求立即生效。
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void test()}
                    disabled={Boolean(user) && (testing || (!publicKey && !config.publicKeyConfigured) || (!secretKey && !config.secretKeyConfigured))}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-40"
                  >
                    {testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    测试连接
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={Boolean(user) && (saving)}
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40"
                  >
                    {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存配置
                  </button>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
