"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@web/lib/auth/client";

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
    reservedOutputTokens?: number;
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

type PlanStep = {
  type: "plan";
  index: number;
  durationMs?: number;
  planId: string;
  stepId?: string;
  phase: "created" | "executed" | "verified";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  goal: string;
  successCriteria: string[];
  allowedTools: string[];
  resultSummary?: string;
  failureReason?: string;
};

type RetrievalStep = {
  type: "retrieval";
  index: number;
  durationMs?: number;
  phase: "routed" | "graded";
  planId: string;
  route: "no_retrieval" | "knowledge" | "web" | "both";
  reason: string;
  confidence?: number;
  evidenceRequired?: boolean;
  maxAttempts: number;
  indexVersion: string;
  source?: "knowledge" | "web";
  query?: string;
  filters?: Record<string, unknown>;
  evidenceCount?: number;
  grade?: {
    sufficient: boolean;
    grade: string;
    reason: string;
    topScore: number | null;
    scoreGap: number | null;
    queryCoverage: number;
    acceptedEvidenceIds: string[];
  };
  cacheHits?: number;
  queryAttempts?: number;
  thresholdFallback?: boolean;
  scoreGap?: number | null;
  degradationReason?: string;
  attempts?: Array<Record<string, unknown>>;
  timings?: Record<string, number>;
};

type AnswerValidationStep = {
  type: "answer_validation";
  index: number;
  durationMs?: number;
  guarded: boolean;
  report: {
    status: "pass" | "warn" | "fail";
    evidenceRequired?: boolean;
    evidenceCount: number;
    claimCount: number;
    citedClaimCount: number;
    supportedClaimCount: number;
    citationPrecision: number;
    citationCoverage: number;
    groundedness: number;
    unknownCitationIds: string[];
    checks: Array<Record<string, unknown>>;
  };
};

type MemoryConsolidationStep = {
  type: "memory_consolidation";
  index: number;
  durationMs?: number;
  outcome: Record<string, unknown> & {
    status?: string;
    extractedFactCount?: number;
    persistedCount?: number;
    invalidatedCount?: number;
    purgedCount?: number;
    skippedCount?: number;
    failedCount?: number;
    retriedCount?: number;
    candidateDetails?: Array<Record<string, unknown>>;
  };
};

type MemoryRecallStep = {
  type: "memory_recall";
  index: number;
  durationMs?: number;
  query: string;
  eligible: boolean;
  candidateCount: number;
  selectedCount: number;
  selectedTypes: Record<string, number>;
  selectedSources: Record<string, number>;
  rerank: Record<string, unknown> & {
    used?: boolean;
    reason?: string;
    model?: string;
    mode?: string;
    latencyMs?: number;
    providerRequestId?: string;
    totalTokens?: number;
    candidates?: Array<Record<string, unknown>>;
  };
};

type UserProfileStep = {
  type: "user_profile";
  index: number;
  durationMs?: number;
  configured: boolean;
  injected: boolean;
  revision: number;
  updatedAt?: string;
  contentChars: number;
  injectedChars: number;
  content: string;
  error?: string;
};

type Step =
  | ExecutionStrategyStep
  | ModelStep
  | ToolStep
  | ContextCompactionStep
  | PlanStep
  | RetrievalStep
  | UserProfileStep
  | MemoryRecallStep
  | MemoryConsolidationStep
  | AnswerValidationStep;

type ExecutionStrategyStep = {
  type: "execution_strategy";
  index: number;
  durationMs?: number;
  executionMode: "direct" | "plan";
  requiresPlanReview: boolean;
  reason: string;
  subgoals: string[];
  subgoalCount: number;
  source: string;
  fallbackReason?: string;
  toolsSuppressed: boolean;
  planGenerationFailed: boolean;
};

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
    const attempts = asRecordArray(metadata.ragAttempts);
    const hasContextStats = [
      metadata.ragContextTokens,
      metadata.ragContextSourceCount,
      metadata.ragContextTruncated,
      metadata.ragParentContextsDeduped,
    ].some((value) => value !== undefined);
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
          <span className={metadata.ragUsedFallback ? "text-amber-300" : "text-emerald-300"}>
            {metadata.ragUsedFallback ? "受控二级召回" : "正常检索"}
          </span>
        </div>
        <RagDebugSummary debug={metadata.rag} />
        {hasContextStats && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
            <span>上下文 {asNumber(metadata.ragContextTokens) ?? 0} tokens</span>
            <span>父段落 {asNumber(metadata.ragContextSourceCount) ?? 0} 个</span>
            <span>父段落去重 {asNumber(metadata.ragParentContextsDeduped) ?? 0} 个</span>
            <span>截断 {formatEnabled(metadata.ragContextTruncated)}</span>
          </div>
        )}
        {attempts.map((attempt, attemptIndex) => (
          <RagAttemptView
            key={`${asString(attempt.label) ?? "attempt"}-${attemptIndex}`}
            attempt={attempt}
          />
        ))}
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
        <span className="text-emerald-400">接受 {asNumber(attempt.acceptedCount) ?? 0} 条</span>
        {(asNumber(attempt.rejectedCount) ?? 0) > 0 && (
          <span className="text-amber-400">拒绝 {asNumber(attempt.rejectedCount)} 条弱证据</span>
        )}
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
                {asNumber(result.rrfScore) !== undefined && (
                  <span className="text-slate-500">RRF {formatScore(result.rrfScore)}</span>
                )}
                {asNumber(result.crossEncoderScore) !== undefined && (
                  <span className="text-slate-500">
                    Cross-Encoder {formatScore(result.crossEncoderScore)}
                  </span>
                )}
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
  const timings = isRecord(debug.timings) ? debug.timings : {};
  const originalQuery = asString(debug.originalQuery);
  const standaloneQuery = asString(debug.standaloneQuery);
  const crossEncoderStatus = debug.crossEncoderUsed === true
    ? "已执行"
    : asString(debug.crossEncoderReason) ?? formatEnabled(debug.crossEncoderEnabled);

  return (
    <div className="mt-1 space-y-1 text-slate-400">
      {standaloneQuery && standaloneQuery !== originalQuery && (
        <div>
          独立查询：
          <span className="text-slate-300">{standaloneQuery}</span>
        </div>
      )}
      {rewrittenQueries.length > 0 && (
        <div>
          改写：
          <span className="text-slate-300">{rewrittenQueries.join(" | ")}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>类型 {asString(debug.queryType) ?? "-"}</span>
        <span>融合 {asString(debug.fusionStrategy) ?? "-"}</span>
        {debug.fusionStrategy === "rrf" && <span>RRF k={asNumber(debug.rrfK) ?? "-"}</span>}
        <span>
          向量 Query {asNumber(debug.vectorQueryCount) ?? "-"}
          {debug.multiQueryVectorEnabled === false ? "（单 Query）" : "（Multi-query）"}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>候选 {asNumber(debug.candidateCount) ?? "-"}</span>
        <span>候选上限 {asNumber(debug.candidateLimit) ?? "-"}</span>
        <span>向量 {asNumber(debug.vectorCandidateCount) ?? "-"}</span>
        <span>关键词 {asNumber(debug.keywordCandidateCount) ?? "-"}</span>
        <span>融合去重后 {asNumber(debug.mergedCandidateCount) ?? "-"}</span>
        <span>返回 {asNumber(debug.returnedCount) ?? "-"} 条</span>
        <span>
          TopK {asNumber(debug.effectiveMatchCount) ?? "-"}/请求 {asNumber(debug.requestedMatchCount) ?? "-"}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
        <span>向量权重 {formatScore(debug.vectorWeight)}</span>
        <span>关键词权重 {formatScore(debug.keywordWeight)}</span>
        <span>
          MMR {formatEnabled(debug.mmrEnabled)}（{asString(debug.mmrSimilarityMode) ?? "-"}）
        </span>
        <span>规则重排 {formatEnabled(debug.rerankEnabled)}</span>
        <span>Cross-Encoder {crossEncoderStatus}</span>
        {asNumber(debug.topScoreGap) !== undefined && (
          <span>Top gap {formatScore(debug.topScoreGap)}</span>
        )}
        <span>关键词检索 {formatEnabled(debug.keywordSearchEnabled)}</span>
      </div>
      {asNumber(timings.totalMs) !== undefined && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
          <span>并行召回 {asNumber(timings.parallelRecallMs) ?? 0}ms</span>
          <span>Embedding {asNumber(timings.embeddingMs) ?? 0}ms</span>
          <span>
            Embedding cache {asNumber(timings.embeddingCacheHits) ?? 0}/
            {(asNumber(timings.embeddingCacheHits) ?? 0) + (asNumber(timings.embeddingCacheMisses) ?? 0)}
          </span>
          <span>向量 {asNumber(timings.vectorSearchMs) ?? 0}ms</span>
          <span>关键词 {asNumber(timings.keywordSearchMs) ?? 0}ms</span>
          <span>Cross-Encoder {asNumber(timings.crossEncoderMs) ?? 0}ms</span>
          <span>总计 {asNumber(timings.totalMs) ?? 0}ms</span>
        </div>
      )}
      {asString(debug.crossEncoderError) && (
        <div className="text-rose-300">Cross-Encoder 降级：{asString(debug.crossEncoderError)}</div>
      )}
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
        usedFallback: step.metadata.ragUsedFallback === true,
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
  "user-profile": "bg-fuchsia-950/50 text-fuchsia-300",
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

export function TraceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`/api/traces/${id}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "加载失败");
        return data;
      })
      .then((data) => setTrace(data.trace))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          ← 返回 Trace 列表
        </button>

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
                    ) : step.type === "context_compaction" ? (
                      <span className="font-medium text-amber-300">
                        上下文压缩
                      </span>
                    ) : step.type === "execution_strategy" ? (
                      <span className="font-medium text-indigo-300">执行策略 · {step.executionMode === "plan" ? "分阶段计划" : "普通循环"}</span>
                    ) : step.type === "plan" ? (
                      <span className="font-medium text-indigo-300">
                        执行计划 · {step.phase}
                      </span>
                    ) : step.type === "retrieval" ? (
                      <span className="font-medium text-cyan-300">
                        检索闭环 · {step.phase}
                      </span>
                    ) : step.type === "memory_recall" ? (
                      <span className="font-medium text-emerald-300">
                        记忆召回 · {step.rerank.used ? "Qwen3 rerank" : (step.rerank.reason ?? "rule rank")}
                      </span>
                    ) : step.type === "user_profile" ? (
                      <span className="font-medium text-fuchsia-300">
                        用户画像 · {step.injected ? `已注入 v${step.revision}` : "未注入"}
                      </span>
                    ) : step.type === "memory_consolidation" ? (
                      <span className="font-medium text-emerald-300">
                        记忆固化 · {step.outcome.status ?? "unknown"}
                      </span>
                    ) : (
                      <span className={`font-medium ${
                        step.report.status === "pass"
                          ? "text-emerald-300"
                          : step.report.status === "warn"
                            ? "text-amber-300"
                            : "text-rose-300"
                      }`}>
                        回答证据校验 · {step.report.status}
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
                            {step.tokenBudget.reservedOutputTokens
                              ? ` · 输出预留 ${step.tokenBudget.reservedOutputTokens}`
                              : ""}
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
                  ) : step.type === "context_compaction" ? (
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
                  ) : step.type === "execution_strategy" ? (
                    <div className="mt-2 space-y-2 text-xs text-slate-400">
                      <div className="flex flex-wrap gap-3">
                        <span>来源 {step.source}</span>
                        <span>子目标 {step.subgoalCount}</span>
                        <span>计划审核 {step.requiresPlanReview ? "等待用户确认" : "不要求"}</span>
                        <span>具体操作仍按工具权限校验</span>
                      </div>
                      <p>{step.reason}</p>
                      {step.subgoals.length > 0 && <ul className="list-inside list-disc">{step.subgoals.map((goal, index) => <li key={index}>{goal}</li>)}</ul>}
                      {step.toolsSuppressed && <p className="text-amber-300">分类降级：本轮不调用工具（{step.fallbackReason}）</p>}
                      {step.planGenerationFailed && <p className="text-amber-300">计划生成失败，未执行工具</p>}
                    </div>
                  ) : step.type === "plan" ? (
                    <div className="mt-2 text-xs">
                      <div className="text-slate-300">{step.goal}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-slate-500">
                        <span>状态 {step.status}</span>
                        {step.allowedTools.length > 0 && (
                          <span>工具 {step.allowedTools.join(", ")}</span>
                        )}
                      </div>
                      {step.successCriteria.length > 0 && (
                        <div className="mt-1 text-slate-500">
                          验收：{step.successCriteria.join("；")}
                        </div>
                      )}
                      {step.resultSummary && (
                        <Collapsible label="步骤结果" body={step.resultSummary} />
                      )}
                      {step.failureReason && (
                        <div className="mt-2 rounded-lg bg-rose-950/40 px-3 py-2 text-rose-300">
                          {step.failureReason}
                        </div>
                      )}
                    </div>
                  ) : step.type === "retrieval" ? (
                    <div className="mt-2 space-y-2 text-xs">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                        <span>route {step.route}</span>
                        <span>强制证据 {step.evidenceRequired ? "是" : "否"}</span>
                        <span>source {step.source ?? "-"}</span>
                        <span>query {step.query ?? "-"}</span>
                        <span>尝试 {step.queryAttempts ?? 0}/{step.maxAttempts}</span>
                        <span>证据 {step.evidenceCount ?? 0}</span>
                        <span>缓存命中 {step.cacheHits ?? 0}</span>
                        <span className={step.thresholdFallback ? "text-rose-300" : "text-emerald-300"}>
                          降阈值 {step.thresholdFallback ? "是" : "否"}
                        </span>
                      </div>
                      <div className="text-slate-500">
                        reason={step.reason} · index={step.indexVersion}
                        {step.confidence !== undefined
                          ? ` · confidence=${step.confidence.toFixed(2)}`
                          : ""}
                      </div>
                      {step.grade && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                          <span>grade {step.grade.grade}</span>
                          <span>充分 {String(step.grade.sufficient)}</span>
                          <span>top {formatScore(step.grade.topScore)}</span>
                          <span>score gap {formatScore(step.scoreGap)}</span>
                          <span>query coverage {formatScore(step.grade.queryCoverage)}</span>
                        </div>
                      )}
                      {step.degradationReason && (
                        <div className="rounded bg-amber-950/30 px-2 py-1 text-amber-300">
                          降级原因：{step.degradationReason}
                        </div>
                      )}
                      {step.timings && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
                          <span>embedding {step.timings.embeddingMs ?? 0}ms</span>
                          <span>embedding cache {step.timings.embeddingCacheHits ?? 0}/{(step.timings.embeddingCacheHits ?? 0) + (step.timings.embeddingCacheMisses ?? 0)}</span>
                          <span>vector {step.timings.vectorSearchMs ?? 0}ms</span>
                          <span>keyword {step.timings.keywordSearchMs ?? 0}ms</span>
                          <span>fusion {step.timings.fusionMs ?? 0}ms</span>
                          <span>rerank {(step.timings.ruleRerankMs ?? 0) + (step.timings.crossEncoderMs ?? 0)}ms</span>
                          <span>MMR {step.timings.mmrMs ?? 0}ms</span>
                          <span>total {step.timings.totalMs ?? 0}ms</span>
                        </div>
                      )}
                      {step.filters && (
                        <Collapsible label="过滤条件" body={toText(step.filters)} />
                      )}
                      {step.attempts && step.attempts.length > 0 && (
                        <Collapsible label="Query attempts" body={toText(step.attempts)} />
                      )}
                    </div>
                  ) : step.type === "user_profile" ? (
                    <div className="mt-2 space-y-2 text-xs">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                        <span>已配置 {step.configured ? "是" : "否"}</span>
                        <span>已注入 {step.injected ? "是" : "否"}</span>
                        <span>版本 v{step.revision}</span>
                        <span>原始 {step.contentChars} 字符</span>
                        <span>注入 {step.injectedChars} 字符</span>
                        {step.updatedAt && <span>更新 {new Date(step.updatedAt).toLocaleString("zh-CN")}</span>}
                      </div>
                      {step.content ? (
                        <Collapsible
                          label="查看本轮画像上下文（已脱敏）"
                          body={step.content}
                          meta={`${step.injectedChars} 字符`}
                        />
                      ) : (
                        <div className="rounded bg-slate-950 px-2 py-1 text-slate-600">
                          本轮没有可注入的用户画像。
                        </div>
                      )}
                      {step.error && (
                        <div className="rounded bg-rose-950/40 px-2 py-1 text-rose-300">
                          画像读取失败：{step.error}
                        </div>
                      )}
                    </div>
                  ) : step.type === "memory_recall" ? (
                    <div className="mt-2 space-y-2 text-xs">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                        <span>eligible {step.eligible ? "是" : "否"}</span>
                        <span>候选 {step.candidateCount}</span>
                        <span>选中 {step.selectedCount}</span>
                        <span>model {step.rerank.model ?? "-"}</span>
                        <span>rerank {step.rerank.used ? "used" : (step.rerank.reason ?? "-")}</span>
                        <span>耗时 {step.rerank.latencyMs ?? 0}ms</span>
                        <span>tokens {step.rerank.totalTokens ?? "-"}</span>
                      </div>
                      <div className="text-slate-500">query={step.query}</div>
                      {step.rerank.providerRequestId && (
                        <div className="text-slate-500">
                          provider request={step.rerank.providerRequestId}
                        </div>
                      )}
                      <Collapsible
                        label="查看 reranker 候选与分数"
                        body={toText(step.rerank.candidates ?? [])}
                        meta={`${step.rerank.candidates?.length ?? 0} 条候选`}
                      />
                    </div>
                  ) : step.type === "memory_consolidation" ? (
                    <div className="mt-2 space-y-2 text-xs">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                        <span>抽取 {step.outcome.extractedFactCount ?? 0}</span>
                        <span>写入 {step.outcome.persistedCount ?? 0}</span>
                        <span>失效 {step.outcome.invalidatedCount ?? 0}</span>
                        <span>硬删除 {step.outcome.purgedCount ?? 0}</span>
                        <span>跳过 {step.outcome.skippedCount ?? 0}</span>
                        <span>失败 {step.outcome.failedCount ?? 0}</span>
                        <span>重试 {step.outcome.retriedCount ?? 0}</span>
                      </div>
                      <Collapsible
                        label="查看候选明细"
                        body={toText(step.outcome.candidateDetails ?? [])}
                        meta={`${step.outcome.candidateDetails?.length ?? 0} 次事实处理`}
                      />
                      <Collapsible
                        label="查看完整固化结果"
                        body={toText(step.outcome)}
                      />
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2 text-xs">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-400">
                        <span>claims {step.report.claimCount}</span>
                        <span>强制证据 {step.report.evidenceRequired ? "是" : "否"}</span>
                        <span>已引用 {step.report.citedClaimCount}</span>
                        <span>已支持 {step.report.supportedClaimCount}</span>
                        <span>citation precision {(step.report.citationPrecision * 100).toFixed(1)}%</span>
                        <span>citation coverage {(step.report.citationCoverage * 100).toFixed(1)}%</span>
                        <span>groundedness {(step.report.groundedness * 100).toFixed(1)}%</span>
                        <span>guard {step.guarded ? "已触发" : "未触发"}</span>
                      </div>
                      {step.report.unknownCitationIds.length > 0 && (
                        <div className="rounded bg-rose-950/40 px-2 py-1 text-rose-300">
                          未知引用：{step.report.unknownCitationIds.join(", ")}
                        </div>
                      )}
                      <Collapsible label="Claim checks" body={toText(step.report.checks)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
