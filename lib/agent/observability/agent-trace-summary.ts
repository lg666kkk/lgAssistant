import type {
  AnswerValidationTraceStep,
  ContextCompactionTraceStep,
  RetrievalTraceStep,
} from "@/lib/agent/runtime/trace";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

// Keep Langfuse payloads aggregate-only: no user query, evidence text, filters, or compaction summary.
export function summarizeRagRoute(plan: RetrievalPlan) {
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
