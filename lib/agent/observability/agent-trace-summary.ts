import type {
  AnswerValidationTraceStep,
  ContextCompactionTraceStep,
  RetrievalTraceStep,
} from "@/lib/agent/runtime/trace";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

// Keep Langfuse payloads aggregate-only: no user query, evidence text, filters, or compaction summary.
export function summarizeRetrievalRoute(plan: RetrievalPlan) {
  return {
    route: plan.route,
    confidence: plan.confidence,
    evidenceRequired: plan.evidenceRequired,
    maxAttempts: plan.maxAttempts,
    plannedStepCount: plan.steps.length,
    sources: Array.from(new Set(plan.steps.map((step) => step.source))),
    queryType: plan.queryType,
    indexVersion: plan.indexVersion,
  };
}

export function summarizeRetrieval(step: RetrievalTraceStep) {
  return {
    toolName: step.toolName,
    route: step.route,
    source: step.source,
    evidenceRequired: step.evidenceRequired,
    evidenceCount: step.evidenceCount ?? 0,
    queryAttempts: step.queryAttempts ?? 0,
    cacheHits: step.cacheHits ?? 0,
    evidenceSufficient: step.grade?.sufficient,
    evidenceGrade: step.grade?.grade,
    queryCoverage: step.grade?.queryCoverage,
    thresholdFallback: step.thresholdFallback ?? false,
    scoreGap: step.scoreGap ?? null,
    degradationReason: step.degradationReason,
    measuredDurationMs: step.durationMs,
    timings: step.timings,
  };
}

function safeObservationSegment(value: string | undefined) {
  return value
    ?.trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * 用“证据来源 + 实际工具”命名检索 observation。
 *
 * retrieval 是具体操作，RAG 是包含检索、上下文注入和生成的完整模式，因此这里
 * 不再使用 rag.retrieve。工具名来自 Runtime，不维护中央工具名单；未来新增检索
 * 工具只要继续返回 EvidenceBundle，就会自动得到可读且可聚合的 observation 名。
 */
export function retrievalObservationName(step: RetrievalTraceStep) {
  const source = safeObservationSegment(step.source) || "unknown";
  const toolName = safeObservationSegment(step.toolName);
  return toolName ? `retrieval.${source}:${toolName}` : `retrieval.${source}`;
}

export function retrievalObservationLabel(step: RetrievalTraceStep) {
  const sourceLabel = step.source === "web"
    ? "Web 证据检索"
    : step.source === "knowledge"
      ? "个人知识库检索"
      : "外部证据检索";
  return step.toolName ? `${sourceLabel}（${step.toolName}）` : sourceLabel;
}

export function summarizeCompaction(step: ContextCompactionTraceStep) {
  return {
    beforeTokens: step.beforeTokens,
    afterTokens: step.afterTokens,
    tokenReduction: step.beforeTokens - step.afterTokens,
    tokenReductionRatio: step.beforeTokens > 0
      ? (step.beforeTokens - step.afterTokens) / step.beforeTokens
      : 0,
    modelWindowTokens: step.modelWindowTokens,
    triggerTokens: step.triggerTokens,
    targetTokens: step.targetTokens,
    middleMessageCount: step.middleMessageCount,
    method: step.method,
    compressionModel: step.compressionModel,
    fallbackReason: step.fallbackReason,
    measuredDurationMs: step.durationMs,
  };
}

export function summarizeAnswerValidation(step: AnswerValidationTraceStep) {
  return {
    status: step.report.status,
    evidenceRequired: step.report.evidenceRequired,
    evidenceCount: step.report.evidenceCount,
    claimCount: step.report.claimCount,
    citedClaimCount: step.report.citedClaimCount,
    supportedClaimCount: step.report.supportedClaimCount,
    citationPrecision: step.report.citationPrecision,
    citationCoverage: step.report.citationCoverage,
    groundedness: step.report.groundedness,
    unknownCitationCount: step.report.unknownCitationIds.length,
    guarded: step.guarded,
    measuredDurationMs: step.durationMs,
  };
}
