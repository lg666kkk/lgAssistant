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
  systemSegments?: Array<{
    kind: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asRecordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function formatScore(value: unknown) {
  const number = asNumber(value);
  return number === undefined ? "-" : number.toFixed(3);
}

function formatEnabled(value: unknown) {
  if (value === true) return "开启";
  if (value === false) return "关闭";
  return "-";
}

function RagMetadataView({ metadata }: { metadata: Record<string, unknown> }) {
  if (metadata.type === "rag_auto_knowledge") {
    const attempts = asRecordArray(metadata.attempts);
    return (
      <div className="mt-2 space-y-2 rounded-lg border border-cyan-900/60 bg-cyan-950/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-cyan-200">
          <span className="font-medium">RAG 自动检索</span>
          <span className="rounded bg-cyan-950 px-1.5 py-0.5">
            {asString(metadata.query) ?? "unknown query"}
          </span>
          <span className="text-cyan-300/70">{asNumber(metadata.durationMs) ?? "?"}ms</span>
          <span className={metadata.usedFallback ? "text-amber-300" : "text-emerald-300"}>
            {metadata.usedFallback ? "已降级" : "正常检索"}
          </span>
          <span className="text-cyan-300/70">
            返回 {asNumber(metadata.finalReturnedCount) ?? 0} 条
          </span>
        </div>
        {metadata.error ? (
          <div className="rounded bg-rose-950/40 px-2 py-1 text-rose-300">
            {String(metadata.error)}
          </div>
        ) : null}
        {attempts.map((attempt, attemptIndex) => (
          <RagAttemptView
            key={`${asString(attempt.label) ?? "attempt"}-${attemptIndex}`}
            attempt={attempt}
          />
        ))}
        <Collapsible label="Raw RAG metadata" body={toText(metadata)} />
      </div>
    );
  }

  if (isRecord(metadata.rag)) {
    return (
      <div className="mt-2 space-y-2 rounded-lg border border-cyan-900/60 bg-cyan-950/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-cyan-200">
          <span className="font-medium">RAG 工具检索</span>
          <span className="rounded bg-cyan-950 px-1.5 py-0.5">
            {asString(metadata.rag.originalQuery) ?? "unknown query"}
          </span>
          <span className="text-cyan-300/70">
            返回 {asNumber(metadata.ragReturnedCount) ?? asNumber(metadata.rag.returnedCount) ?? 0} 条
          </span>
        </div>
        <RagDebugSummary debug={metadata.rag} />
        <Collapsible label="Raw tool metadata" body={toText(metadata)} />
      </div>
    );
  }

  return <Collapsible label="调试信息" body={toText(metadata)} meta="metadata" />;
}

function RagAttemptView({ attempt }: { attempt: Record<string, unknown> }) {
  const debug = isRecord(attempt.debug) ? attempt.debug : {};
  const topResults = asRecordArray(attempt.topResults);

  return (
    <div className="rounded-lg bg-slate-950/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-slate-300">
        <span className="font-medium">{asString(attempt.label) ?? "attempt"}</span>
        <span className="text-slate-500">阈值 {formatScore(attempt.threshold)}</span>
        <span className="text-slate-500">返回 {asNumber(debug.returnedCount) ?? 0} 条</span>
      </div>
      <RagDebugSummary debug={debug} />
      {topResults.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {topResults.map((result, index) => (
            <div key={`${asString(result.id) ?? index}`} className="rounded bg-slate-900 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-2 text-slate-200">
                <span>#{asNumber(result.rank) ?? index + 1}</span>
                <span className="font-medium">{asString(result.pageTitle) ?? "(无标题)"}</span>
                <span className="text-slate-500">分数 {formatScore(result.rerankScore)}</span>
                <span className="text-slate-500">向量 {formatScore(result.vectorScore)}</span>
                <span className="text-slate-500">关键词 {formatScore(result.keywordScore)}</span>
                {Array.isArray(result.retrievalSources) && (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-cyan-300">
                    {result.retrievalSources.join("+")}
                  </span>
                )}
              </div>
              {Array.isArray(result.headingPath) && result.headingPath.length > 0 && (
                <div className="mt-0.5 text-slate-500">
                  位置：{result.headingPath.filter((v) => typeof v === "string").join(" / ")}
                </div>
              )}
              {asString(result.excerpt) && (
                <div className="mt-1 text-slate-400">{asString(result.excerpt)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RagDebugSummary({ debug }: { debug: Record<string, unknown> }) {
  const rewrittenQueries = Array.isArray(debug.rewrittenQueries)
    ? debug.rewrittenQueries.filter((query): query is string => typeof query === "string")
    : [];

  return (
    <div className="mt-1 space-y-1 text-slate-400">
      {rewrittenQueries.length > 0 && (
        <div>
          改写：
          <span className="text-slate-300">{rewrittenQueries.join(" | ")}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>候选 {asNumber(debug.candidateCount) ?? "-"}</span>
        <span>向量 {asNumber(debug.vectorCandidateCount) ?? "-"}</span>
        <span>关键词 {asNumber(debug.keywordCandidateCount) ?? "-"}</span>
        <span>合并 {asNumber(debug.mergedCandidateCount) ?? "-"}</span>
        <span>返回 {asNumber(debug.returnedCount) ?? "-"} 条</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
        <span>向量权重 {formatScore(debug.vectorWeight)}</span>
        <span>关键词权重 {formatScore(debug.keywordWeight)}</span>
        <span>MMR {formatEnabled(debug.mmrEnabled)}</span>
        <span>重排 {formatEnabled(debug.rerankEnabled)}</span>
        <span>关键词检索 {formatEnabled(debug.keywordSearchEnabled)}</span>
      </div>
    </div>
  );
}

type RagObservation = {
  source: "auto" | "tool";
  query: string;
  returnedCount: number;
  durationMs?: number;
  usedFallback?: boolean;
  error?: string;
  debug: Record<string, unknown>;
  topResults: Record<string, unknown>[];
};

function getLatestAttempt(metadata: Record<string, unknown>) {
  const attempts = asRecordArray(metadata.attempts);
  return attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

function collectRagObservations(trace: Trace): RagObservation[] {
  const observations: RagObservation[] = [];

  for (const step of trace.steps) {
    if (step.type === "model") {
      for (const segment of step.systemSegments ?? []) {
        const metadata = segment.metadata;
        if (!metadata || metadata.type !== "rag_auto_knowledge") continue;

        const attempt = getLatestAttempt(metadata);
        observations.push({
          source: "auto",
          query: asString(metadata.query) ?? "",
          returnedCount: asNumber(metadata.finalReturnedCount) ?? 0,
          durationMs: asNumber(metadata.durationMs),
          usedFallback: metadata.usedFallback === true,
          error: asString(metadata.error),
          debug: isRecord(attempt?.debug) ? attempt.debug : {},
          topResults: asRecordArray(attempt?.topResults),
        });
      }
      continue;
    }

    if (step.type === "tool" && step.name === "search_notes" && step.metadata) {
      observations.push({
        source: "tool",
        query: asString(step.metadata.ragQuery) ?? asString((step.metadata.rag as any)?.originalQuery) ?? "",
        returnedCount:
          asNumber(step.metadata.ragReturnedCount) ??
          (isRecord(step.metadata.rag) ? asNumber(step.metadata.rag.returnedCount) : undefined) ??
          0,
        durationMs: step.durationMs,
        error: step.ok ? undefined : step.error,
        debug: isRecord(step.metadata.rag) ? step.metadata.rag : {},
        topResults: asRecordArray(step.metadata.ragTopResults),
      });
    }
  }

  return observations;
}

function firstKnowledgeToolOrder(trace: Trace) {
  const toolNames = trace.steps
    .filter((step): step is ToolStep => step.type === "tool")
    .map((step) => step.name)
    .filter((name) => name === "search_notes" || name === "web_search");

  return {
    toolNames,
    first: toolNames[0],
    searchNotesCalled: toolNames.includes("search_notes"),
    webSearchCalled: toolNames.includes("web_search"),
  };
}

function maxReturnedCount(observations: RagObservation[]) {
  return observations.reduce((max, observation) => Math.max(max, observation.returnedCount), 0);
}

function topScore(observations: RagObservation[]) {
  const scores = observations.flatMap((observation) =>
    observation.topResults
      .map((result) => asNumber(result.rerankScore))
      .filter((score): score is number => score !== undefined),
  );
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

function RagTraceOverview({ trace }: { trace: Trace }) {
  const observations = collectRagObservations(trace);
  const toolOrder = firstKnowledgeToolOrder(trace);
  const fallbackUsed = observations.some((observation) => observation.usedFallback);
  const hasNoResult = observations.length > 0 && maxReturnedCount(observations) === 0;
  const hasErrors = observations.some((observation) => observation.error);
  const bestScore = topScore(observations);

  if (
    observations.length === 0 &&
    !toolOrder.searchNotesCalled &&
    !toolOrder.webSearchCalled
  ) {
    return null;
  }

  const searchNotesPriority =
    toolOrder.first === "search_notes"
      ? "search_notes 优先"
      : toolOrder.searchNotesCalled
        ? "search_notes 已调用"
        : observations.some((observation) => observation.source === "auto")
          ? "自动 RAG 已注入"
          : "未调用 search_notes";

  return (
    <div className="mt-4 rounded-xl border border-cyan-900/60 bg-cyan-950/20 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="font-medium text-cyan-200">RAG 观测</span>
        <span className={maxReturnedCount(observations) > 0 ? "text-emerald-300" : "text-amber-300"}>
          {hasNoResult ? "无结果" : `返回 ${maxReturnedCount(observations)} 条`}
        </span>
        <span className={fallbackUsed ? "text-amber-300" : "text-slate-400"}>
          {fallbackUsed ? "触发降级" : "未降级"}
        </span>
        <span className="text-slate-400">{searchNotesPriority}</span>
        {bestScore !== undefined && (
          <span className="text-slate-400">最高分 {bestScore.toFixed(3)}</span>
        )}
        {hasErrors && <span className="text-rose-300">有错误</span>}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {observations.map((observation, index) => (
          <div
            key={`${observation.source}-${index}`}
            className="rounded-lg bg-slate-950/70 px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  observation.source === "auto"
                    ? "bg-cyan-900/70 text-cyan-200"
                    : "bg-emerald-900/60 text-emerald-200"
                }`}
              >
                {observation.source === "auto" ? "自动 RAG" : "知识库工具"}
              </span>
              <span className="text-slate-300">{observation.query || "unknown query"}</span>
              <span className="text-slate-500">{observation.durationMs ?? "?"}ms</span>
            </div>

            <RagDebugSummary debug={observation.debug} />

            {observation.error && (
              <div className="mt-2 rounded bg-rose-950/40 px-2 py-1 text-rose-300">
                {observation.error}
              </div>
            )}

            {observation.topResults.length > 0 && (
              <div className="mt-2 space-y-1">
                {observation.topResults.map((result, resultIndex) => (
                  <div key={`${asString(result.id) ?? resultIndex}`} className="rounded bg-slate-900 px-2 py-1">
                    <div className="flex flex-wrap items-center gap-2 text-slate-300">
                      <span>#{asNumber(result.rank) ?? resultIndex + 1}</span>
                      <span>{asString(result.pageTitle) ?? "(无标题)"}</span>
                      <span className="text-slate-500">分数 {formatScore(result.rerankScore)}</span>
                    </div>
                    {asString(result.pageUrl) && (
                      <div className="mt-0.5 truncate text-slate-500">
                        来源：{asString(result.pageUrl)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 text-xs text-slate-500">
        说明：线上 trace 没有标准答案，不能直接给出真实命中率/误召回率；这里展示的是返回数量、最高分、是否降级、顶部结果等代理指标。真实命中率请用离线 RAG eval case 评估。
      </div>
    </div>
  );
}

function SystemSegmentBlock({
  segment,
}: {
  segment: { kind: string; title: string; content: string; metadata?: Record<string, unknown> };
}) {
  const [open, setOpen] = useState(segment.kind !== "task-context");

  return (
    <div className="rounded-lg bg-slate-950 px-3 py-2">
      <button
        onClick={() => setOpen((value) => !value)}
        className="grid w-full grid-cols-[16px_88px_minmax(0,1fr)] items-center gap-2 text-left"
      >
        <span className="text-xs text-slate-500">{open ? "▼" : "▶"}</span>
        <span
          className={`block w-[88px] rounded-md px-1.5 py-0.5 text-center text-[11px] leading-4 ${
            SEGMENT_KIND_CLASS[segment.kind] ?? "bg-slate-800 text-slate-400"
          }`}
        >
          {segment.title}
        </span>
        <span className="min-w-0 truncate text-xs text-slate-500">
          {segment.content.replace(/\s+/g, " ").slice(0, 120)}
        </span>
      </button>
      {open && (
        <>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">
            {segment.content}
          </pre>
          {segment.metadata && (
            <RagMetadataView metadata={segment.metadata} />
          )}
        </>
      )}
    </div>
  );
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
              <SystemSegmentBlock
                key={`${seg.kind}-${i}`}
                segment={seg}
              />
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

            <RagTraceOverview trace={trace} />

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
                        <RagMetadataView metadata={step.metadata} />
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
