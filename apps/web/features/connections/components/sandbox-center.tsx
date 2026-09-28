"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, Save, Zap } from "lucide-react";
import { authFetch } from "@web/lib/auth/client";

type E2BConfig = {
  configured: boolean;
  hint?: string;
  source: "user" | "environment" | "unset";
  updatedAt?: string;
  lastTestStatus?: "ok" | "error";
  lastTestLatencyMs?: number;
};

const initialConfig: E2BConfig = { configured: false, source: "unset" };

export function SandboxCenter() {
  const [config, setConfig] = useState<E2BConfig>(initialConfig);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/sandbox/config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取沙盒配置失败");
      setConfig(data);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "读取沙盒配置失败" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await authFetch("/api/sandbox/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存 E2B API Key 失败");
      setApiKey("");
      setShowKey(false);
      await load();
      setNotice({ ok: true, text: "E2B API Key 已保存" });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "保存 E2B API Key 失败" });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!config.configured) return;
    setTesting(true);
    setNotice(null);
    try {
      const response = await authFetch("/api/sandbox/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "E2B 连接测试失败");
      await load();
      setNotice({ ok: true, text: `E2B 密钥有效，响应耗时 ${data.latencyMs} ms` });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "E2B 连接测试失败" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-4xl">
        <div className="border-b border-slate-800 pb-5">
          <h2 className="text-xl font-semibold text-slate-100">沙盒环境</h2>
        </div>
        {notice && (
          <div role="status" className={`mt-5 flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm ${notice.ok ? "border-emerald-900/70 text-emerald-300" : "border-rose-900/70 text-rose-300"}`}>
            {notice.ok && <CheckCircle2 className="h-4 w-4 shrink-0" />}{notice.text}
          </div>
        )}
        {loading ? (
          <div className="flex h-48 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />加载沙盒配置</div>
        ) : (
          <section className="py-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-sm font-medium text-slate-100">E2B</h3>
                <p className="mt-1 text-xs text-slate-500">Skill 执行环境</p>
              </div>
              <span className={`text-sm ${config.configured ? "text-emerald-400" : "text-slate-500"}`}>
                {config.configured ? `已配置 ${config.hint ?? ""}` : "未配置"}
              </span>
            </div>
            <div className="max-w-2xl py-5">
              <label htmlFor="sandbox-e2b-key" className="mb-1.5 block text-xs font-medium text-slate-400">API Key</label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" />
                <input
                  id="sandbox-e2b-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={saving}
                  placeholder={config.configured ? "留空保持原值" : "输入 E2B API Key"}
                  className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-11 text-sm text-slate-100 outline-none focus:border-cyan-500 disabled:opacity-50"
                />
                <button type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏输入" : "显示输入"} aria-label={showKey ? "隐藏 API Key 输入" : "显示 API Key 输入"} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:text-slate-200">
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {config.configured && <p className="mt-2 text-xs text-slate-500">来源：{config.source === "user" ? "当前账户" : "服务器环境变量"}</p>}
              {config.lastTestStatus && <p className="mt-2 text-xs text-slate-500">最近测试：{config.lastTestStatus === "ok" ? "成功" : "失败"}{config.lastTestLatencyMs ? `，${config.lastTestLatencyMs} ms` : ""}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
              <button type="button" onClick={() => void test()} disabled={!config.configured || testing || saving} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50">
                {testing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}测试连接
              </button>
              <button type="button" onClick={() => void save()} disabled={!apiKey.trim() || saving || testing} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存配置
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
