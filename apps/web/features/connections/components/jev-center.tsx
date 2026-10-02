"use client";

import { ToastNotice } from "@web/components/ui/toast";

import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle, Save, Zap } from "lucide-react";
import { authFetch } from "@web/lib/auth/client";

type Config = {
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  modelId: string;
  lastTestStatus?: "ok" | "error";
  lastTestLatencyMs?: number;
};

const initial: Config = {
  baseUrl: "https://api.typesafe.ai/v1",
  apiKeyConfigured: false,
  apiKeyHint: "",
  modelId: "jev-latest",
};

export function JevCenter() {
  const [config, setConfig] = useState<Config>(initial);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/jev/config", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取 Jev 配置失败");
      setConfig(data);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "读取 Jev 配置失败" });
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true); setNotice(null);
    try {
      const response = await authFetch("/api/jev/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: config.baseUrl, modelId: config.modelId, apiKey: apiKey || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存 Jev 配置失败");
      setApiKey(""); await load();
      setNotice({ ok: true, text: "Jev 配置已加密保存" });
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "保存 Jev 配置失败" }); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setNotice(null);
    try {
      const response = await authFetch("/api/jev/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Jev 连接测试失败");
      await load(); setNotice({ ok: true, text: `连接成功，响应耗时 ${data.latencyMs} ms` });
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "Jev 连接测试失败" }); }
    finally { setTesting(false); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto max-w-4xl">
        <div className="border-b border-slate-800 pb-5">
          <h2 className="text-xl font-semibold text-slate-100">Jev 结构化决策</h2>
          <p className="mt-1 text-sm text-slate-500">配置 TypeSafe Jev，用于路由、评分和真假判断。它不参与普通聊天回复。</p>
        </div>
        {notice && <ToastNotice tone={notice.ok ? "success" : "error"}>{notice.text}</ToastNotice>}
        {loading ? <div className="flex h-52 items-center justify-center text-slate-500"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载 Jev 配置</div> : (
          <section className="py-6">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-400">Base URL</span>
                <input className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500" value={config.baseUrl} onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} placeholder="https://api.typesafe.ai/v1" />
              </label>
              <label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-400">模型 ID</span>
                <input className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500" value={config.modelId} onChange={(e) => setConfig({ ...config, modelId: e.target.value })} placeholder="jev-latest" />
              </label>
              <label className="block md:col-span-2"><span className="mb-1.5 block text-xs font-medium text-slate-400">API Key {config.apiKeyConfigured && <span className="text-emerald-500">（已配置 {config.apiKeyHint}）</span>}</span>
                <div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-600" /><input type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-cyan-500" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config.apiKeyConfigured ? "留空保持原值" : "ts_..."} /></div>
              </label>
            </div>
            <div className="mt-6 flex flex-wrap justify-between gap-3 border-t border-slate-800 pt-4">
              <button type="button" onClick={() => void test()} disabled={testing || saving || !config.apiKeyConfigured} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50"><Zap className="h-4 w-4" />{testing ? "测试中" : "测试连接"}</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"><Save className="h-4 w-4" />{saving ? "保存中" : "保存配置"}</button>
            </div>
            {config.lastTestStatus && <p className="mt-3 text-xs text-slate-500">最近测试：{config.lastTestStatus === "ok" ? "成功" : "失败"}{config.lastTestLatencyMs ? `，${config.lastTestLatencyMs} ms` : ""}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
