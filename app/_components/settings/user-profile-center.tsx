"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Check,
  Eye,
  FileText,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import type { UserProfileView } from "@/lib/user-profile/types";

const STARTER_TEMPLATE = `# 关于我

## 基本信息
- 称呼：
- 所在时区：Asia/Shanghai
- 当前角色：

## 沟通偏好
- 默认使用中文回答
- 先给结论，再解释关键依据

## 当前重点
- 

## 长期协作约定
- `;

export function UserProfileCenter() {
  const [profile, setProfile] = useState<UserProfileView | null>(null);
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/user-profile", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "读取用户画像失败");
      const next = payload as UserProfileView;
      setProfile(next);
      setContent(next.content);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取用户画像失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const dirty = profile !== null && content.trim() !== profile.content;
  const estimatedTokens = useMemo(() => Math.ceil(content.length / 3), [content.length]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/user-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存用户画像失败");
      const next = payload as UserProfileView;
      setProfile(next);
      setContent(next.content);
      setNotice(next.configured
        ? `用户画像已保存为 v${next.revision}，下一次聊天请求立即生效。`
        : "用户画像已清空，下一次聊天请求不再注入画像。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存用户画像失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-hidden bg-slate-950 px-5 py-6 text-slate-200">
      <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col">
        <div className="shrink-0 flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-100">用户画像</h2>
              {profile?.configured && (
                <span className="rounded-full border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-300">
                  已启用 · v{profile.revision}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              类似 USER.md：保存你确认过的稳定信息、偏好与协作约定，不由自动记忆静默改写。
            </p>
            <div className="mt-2 flex items-start gap-2 text-xs text-amber-300/80">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              每次聊天都会把画像作为独立上下文注入，并写入当前用户的 Trace 与 Langfuse；敏感字段会按现有规则脱敏后上报。
            </div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新
          </button>
        </div>

        {(error || notice) && (
          <div className={`mt-5 flex shrink-0 items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${error ? "border-rose-900/70 bg-rose-950/30 text-rose-300" : "border-emerald-900/70 bg-emerald-950/20 text-emerald-300"}`}>
            {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <Check className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{error ?? notice}</span>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-slate-500"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />加载用户画像</div>
        ) : profile ? (
          <section className="mt-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/30">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-1 rounded-md bg-slate-950 p-1">
                <button type="button" onClick={() => setMode("edit")} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm ${mode === "edit" ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}>
                  <FileText className="h-4 w-4" />编辑
                </button>
                <button type="button" onClick={() => setMode("preview")} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm ${mode === "preview" ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"}`}>
                  <Eye className="h-4 w-4" />预览
                </button>
              </div>
              <div className="text-xs text-slate-500">
                {content.length}/{profile.maxChars} 字符 · 约 {estimatedTokens} tokens
                {profile.updatedAt ? ` · 更新于 ${new Date(profile.updatedAt).toLocaleString("zh-CN")}` : ""}
              </div>
            </div>

            {mode === "edit" ? (
              <textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setNotice(null);
                }}
                maxLength={profile.maxChars}
                spellCheck={false}
                placeholder="写下你希望 Agent 长期了解并在每次对话中遵循的稳定信息……"
                className="min-h-0 flex-1 resize-none overflow-y-auto bg-slate-950/70 px-5 py-4 font-mono text-sm leading-6 text-slate-200 outline-none placeholder:text-slate-700"
              />
            ) : content.trim() ? (
              <article className="min-h-0 max-w-none flex-1 overflow-y-auto overscroll-contain bg-slate-950/70 px-6 py-5 text-sm leading-7 text-slate-300 [&_a]:text-cyan-300 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-700 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-slate-900 [&_code]:px-1 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-slate-100 [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-100 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:font-semibold [&_h3]:text-slate-200 [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3 [&_strong]:text-slate-100">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </article>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-950/70 text-sm text-slate-600">暂无可预览内容</div>
            )}

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2">
                {!content.trim() && (
                  <button type="button" onClick={() => { setContent(STARTER_TEMPLATE); setMode("edit"); setNotice(null); }} className="h-9 rounded-md border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800">
                    使用推荐模板
                  </button>
                )}
                {content.trim() && (
                  <button type="button" onClick={() => { setContent(""); setMode("edit"); setNotice(null); }} className="h-9 rounded-md border border-slate-700 px-3 text-sm text-slate-400 hover:border-rose-900 hover:bg-rose-950/20 hover:text-rose-300">
                    清空画像
                  </button>
                )}
              </div>
              <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="inline-flex h-9 items-center gap-2 rounded-md bg-cyan-600 px-4 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40">
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存画像
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
