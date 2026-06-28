"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/lib/auth/auth-gate";
import { authFetch } from "@/lib/auth/client";

type ModelStep = {
  type: "model";
  model?: string;
  index: number;
  durationMs?: number;
  textSummary: string;
  textTruncated: boolean;
  textOriginalChars: number;
  requestedToolCalls: Array<{ name: string; id: string; input: unknown }>;
  estimatedContextTokens: number;
  tokenBudget?: {
    max?: number;
    spentBefore?: number;
    spentAfter?: number;
    remainingBefore?: number;
    remainingAfter?: number;
    requested?: number;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    cacheCreationTokens?: number;
    cacheHitRate?: number;
    estimatedCostCny?: number;
  };
  systemPrompt?: string;
  systemPromptTruncated?: boolean;
  systemPromptOriginalChars?: number;
  systemSegments?: Array<{ kind: string; title: string; content: string }>;
};

type ToolStep = {
  type: "tool";
  index: number;
  durationMs?: number;
  name: string;
  toolCallId?: string;
  input: unknown;
  ok: boolean;
  contentSummary: string;
  contentTruncated: boolean;
  contentOriginalChars: number;
  rawContentSummary?: string;
  rawContentTruncated?: boolean;
  rawContentOriginalChars?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  costPerUse: number;
};

type ContextCompactionStep = {
  type: "context_compaction";
  index: number;
  durationMs?: number;
  beforeTokens: number;
  afterTokens: number;
  modelWindowTokens: number;
  triggerTokens: number;
  targetTokens: number;
  primerMessages: number;
  recentMessages: number;
  middleMessageCount: number;
  reason: string;
  summary: string;
  summaryChars: number;
  method?: "deterministic" | "semantic";
  compressionModel?: string;
  fallbackReason?: string;
};

type Step = ModelStep | ToolStep | ContextCompactionStep;

type Trace = {
  id: string;
  request_id: string;
  session_id: string | null;
  stop_reason: string;
  completed: boolean;
  total_duration_ms: number | null;
  steps: Step[];
  metrics: {
    modelCallCount?: number;
    toolCallCount?: number;
    estimatedTokensSpent?: number;
    actualInputTokens?: number;
    actualOutputTokens?: number;
    actualTotalTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    estimatedModelCostCny?: number;
    totalToolCost?: number;
  };
  created_at: string;
};

// 折叠展示长文本（system prompt / 工具结果 / 入参）
function Collapsible({
  label,
  body,
  meta,
}: {
  label: string;
  body: string;
  meta?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>{label}</span>
        {meta && <span className="text-slate-600">{meta}</span>}
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-950 px-3 py-2 text-xs text-slate-300">
          {body}
        </pre>
      )}
    </div>
  );
}

function toText(v: unknown) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

// 段类型 → 标签配色，一眼区分注入来源
const SEGMENT_KIND_CLASS: Record<string, string> = {
  identity: "bg-violet-950/50 text-violet-300",
  memory: "bg-emerald-950/50 text-emerald-300",
  "task-context": "bg-cyan-950/50 text-cyan-300",
  "web-search-policy": "bg-sky-950/50 text-sky-300",
};

// 注入的 system 上下文：优先按段分块展示；旧 trace 没有 segments 时回退到整段文本
function SystemContext({ step }: { step: ModelStep }) {
  const [open, setOpen] = useState(false);
  const segments = step.systemSegments ?? [];

  // 既无段也无整段文本 → 不渲染（如某些 step 没注入 system）
  if (segments.length === 0 && !step.systemPrompt) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>
          注入的 system 上下文
          {segments.length > 0 && `（${segments.length} 段）`}
        </span>
      </button>
      {open &&
        (segments.length > 0 ? (
          <div className="mt-1 space-y-1.5">
            {segments.map((seg, i) => (
              <div
                key={`${seg.kind}-${i}`}
                className="rounded-lg bg-slate-950 px-3 py-2"
              >
                <span
                  className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] ${
                    SEGMENT_KIND_CLASS[seg.kind] ?? "bg-slate-800 text-slate-400"
                  }`}
                >
                  {seg.title}
                </span>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">
                  {seg.content}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          // 回退：旧 trace 只有整段字符串
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-950 px-3 py-2 text-xs text-slate-300">
            {step.systemPrompt}
            {step.systemPromptTruncated && (
              <span className="text-slate-600">
                {" "}
                …（{step.systemPromptOriginalChars} 字符已截断）
              </span>
            )}
          </pre>
        ))}
    </div>
  );
}

export default function TraceDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`/api/traces/${params.id}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "加载失败");
        return data;
      })
      .then((data) => setTrace(data.trace))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id]);

  return (
    <AuthGate>
    <div className="h-screen overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link
          href="/traces"
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          ← 返回 Trace 列表
        </Link>

        {loading && <div className="mt-6 text-slate-500">加载中...</div>}
        {error && (
          <div className="mt-6 rounded-xl border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        {trace && (
          <>
            {/* 概览 */}
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="text-slate-100">
                  stopReason:{" "}
                  <span className="font-medium">{trace.stop_reason}</span>
                </span>
                <span className="text-slate-400">
                  completed: {String(trace.completed)}
                </span>
                <span className="text-slate-400">
                  耗时 {trace.total_duration_ms ?? "?"}ms
                </span>
                <span className="text-slate-400">
                  🧠 {trace.metrics?.modelCallCount ?? 0} 次模型
                </span>
                <span className="text-slate-400">
                  🔧 {trace.metrics?.toolCallCount ?? 0} 次工具
                </span>
                <span className="text-slate-400">
                  ~{trace.metrics?.estimatedTokensSpent ?? 0} tok
                </span>
                <span className="text-slate-400">
                  真实 {trace.metrics?.actualTotalTokens ?? 0} tok
                </span>
                <span className="text-slate-400">
                  费用 ¥{(trace.metrics?.estimatedModelCostCny ?? 0).toFixed(4)}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-600">
                {trace.request_id} · {new Date(trace.created_at).toLocaleString("zh-CN")}
              </div>
            </div>

            {/* 时间线 */}
            <div className="mt-6 space-y-3">
              {trace.steps.map((step) => (
                <div
                  key={step.index}
                  className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                      #{step.index}
                    </span>
                    {step.type === "model" ? (
                      <span className="font-medium text-sky-400">
                        🧠 {step.model ?? "model"}
                      </span>
                    ) : step.type === "tool" ? (
                      <span
                        className={`font-medium ${
                          step.ok ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        🔧 {step.name} {step.ok ? "" : "(失败)"}
                      </span>
                    ) : (
                      <span className="font-medium text-amber-300">
                        上下文压缩
                      </span>
                    )}
                    <span className="ml-auto text-xs text-slate-600">
                      {step.durationMs ?? "?"}ms
                    </span>
                  </div>

                  {step.type === "model" ? (
                    <div className="mt-2">
                      {step.textSummary && (
                        <div className="whitespace-pre-wrap text-sm text-slate-300">
                          {step.textSummary}
                          {step.textTruncated && (
                            <span className="text-slate-600">
                              {" "}
                              …（{step.textOriginalChars} 字符已截断）
                            </span>
                          )}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {step.requestedToolCalls.length > 0 ? (
                          step.requestedToolCalls.map((tc) => (
                            <span
                              key={tc.id}
                              className="rounded-md bg-sky-950/50 px-2 py-0.5 text-sky-300"
                            >
                              → 调用 {tc.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-slate-600">→ 输出最终回答</span>
                        )}
                        <span className="text-slate-600">
                          上下文 ~{step.estimatedContextTokens} tok
                        </span>
                        {step.tokenBudget && (
                          <span className="text-slate-600">
                            预算 {step.tokenBudget.spentBefore ?? 0}→
                            {step.tokenBudget.spentAfter ?? 0}/
                            {step.tokenBudget.max ?? "?"} · 剩余{" "}
                            {step.tokenBudget.remainingAfter ?? "?"}
                          </span>
                        )}
                        {step.usage && (
                          <span className="text-slate-600">
                            真实 in/out {step.usage.inputTokens ?? "?"}/
                            {step.usage.outputTokens ?? "?"} · 总{" "}
                            {step.usage.totalTokens ?? "?"} · ¥
                            {(step.usage.estimatedCostCny ?? 0).toFixed(4)}
                          </span>
                        )}
                        {step.usage &&
                          ((step.usage.cacheHitTokens ?? 0) > 0 ||
                            (step.usage.cacheMissTokens ?? 0) > 0 ||
                            (step.usage.cacheCreationTokens ?? 0) > 0) && (
                          <span className="text-slate-600">
                            缓存命中{" "}
                            {((step.usage.cacheHitRate ?? 0) * 100).toFixed(1)}%
                            {step.usage.cacheCreationTokens
                              ? ` · 创建 ${step.usage.cacheCreationTokens}`
                              : ""}
                          </span>
                        )}
                      </div>
                      {/* 上下文工程可观测性核心：按段展示注入的 system 上下文 */}
                      <SystemContext step={step} />
                      {step.requestedToolCalls.length > 0 && (
                        <Collapsible
                          label="查看工具入参"
                          body={toText(
                            step.requestedToolCalls.map((t) => ({
                              name: t.name,
                              input: t.input,
                            })),
                          )}
                        />
                      )}
                    </div>
                  ) : step.type === "tool" ? (
                    <div className="mt-2">
                      <Collapsible label="入参" body={toText(step.input)} />
                      <Collapsible
                        label="压缩后结果（给模型）"
                        body={step.contentSummary}
                        meta={
                          step.contentTruncated
                            ? `（${step.contentOriginalChars} 字符已截断）`
                            : undefined
                        }
                      />
                      {step.rawContentSummary && (
                        <Collapsible
                          label="原始结果预览（压缩前）"
                          body={step.rawContentSummary}
                          meta={
                            step.rawContentTruncated
                              ? `（${step.rawContentOriginalChars} 字符已截断）`
                              : undefined
                          }
                        />
                      )}
                      {step.metadata && (
                        <Collapsible
                          label="工具 metadata"
                          body={toText(step.metadata)}
                        />
                      )}
                      {step.error && (
                        <div className="mt-2 rounded-lg bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
                          {step.error}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2">
                      <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                        <span>before ~{step.beforeTokens} tok</span>
                        <span>after ~{step.afterTokens} tok</span>
                        <span>window {step.modelWindowTokens}</span>
                        <span>trigger {step.triggerTokens}</span>
                        <span>target {step.targetTokens}</span>
                        {step.method && <span>method {step.method}</span>}
                        {step.compressionModel && (
                          <span>model {step.compressionModel}</span>
                        )}
                        <span>
                          primers {step.primerMessages} · recents{" "}
                          {step.recentMessages}
                        </span>
                        <span>middle {step.middleMessageCount} 条</span>
                      </div>
                      <div className="mt-2 rounded-lg bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                        {step.reason}
                        {step.fallbackReason && (
                          <div className="mt-1 text-amber-300/80">
                            fallback: {step.fallbackReason}
                          </div>
                        )}
                      </div>
                      <Collapsible
                        label="压缩摘要"
                        body={step.summary}
                        meta={`${step.summaryChars} 字符`}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
    </AuthGate>
  );
}
