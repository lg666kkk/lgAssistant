import { describe, expect, it, vi } from "vitest";
import { createTrace } from "@/lib/agent/runtime/trace";
import { buildOnlineScores, reportOnlineScores } from "./online-scores";

describe("online scores", () => {
  it.each(["awaiting_tool_confirmation", "awaiting_user_input", "max_tokens", "error"] as const)("does not score %s as successful completion", (stopReason) => {
    const trace = createTrace("unfinished");
    trace.completed = true;
    trace.stopReason = stopReason;
    expect(buildOnlineScores(trace)).toContainEqual({ name: "agent_completed（Agent 是否正常完成）", value: 0 });
  });
  it("derives terminal, tool, and groundedness scores from an agent trace", () => {
    const trace = createTrace("request-1");
    trace.completed = true;
    trace.totalDurationMs = 240;
    trace.metrics.modelCallCount = 2;
    trace.steps.push(
      {
        type: "tool",
        index: 0,
        startedAt: 1,
        name: "calculator",
        input: {},
        ok: true,
        contentSummary: "42",
        contentTruncated: false,
        contentOriginalChars: 2,
        costPerUse: 0,
      },
      {
        type: "answer_validation",
        index: 1,
        startedAt: 2,
        report: {
          status: "pass",
          evidenceRequired: true,
          evidenceCount: 1,
          claimCount: 1,
          citedClaimCount: 1,
          coveredClaimCount: 1,
          supportedClaimCount: 1,
          citationPrecision: 1,
          citationCoverage: 1,
          groundedness: 1,
          unknownCitationIds: [],
          checks: [],
        },
        guarded: false,
      },
    );

    expect(buildOnlineScores(trace)).toEqual(expect.arrayContaining([
      { name: "agent_completed（Agent 是否正常完成）", value: 1 },
      { name: "tool_error_rate（工具调用失败率）", value: 0 },
      { name: "model_call_count（模型调用次数）", value: 2 },
      { name: "latency_ms（端到端耗时，毫秒）", value: 240 },
      { name: "groundedness（回答主张的证据支撑率）", value: 1 },
      { name: "citation_precision（引用证据有效率）", value: 1 },
    ]));
  });

  it("flushes scores against the active Langfuse trace id", async () => {
    const trace = createTrace("request-2");
    const score = vi.fn();
    const flushAsync = vi.fn().mockResolvedValue(undefined);

    await reportOnlineScores({
      traceId: "a".repeat(32),
      trace,
      environment: "test",
      scoreClient: { score, flushAsync } as any,
    });

    expect(score).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "a".repeat(32),
      name: "agent_completed（Agent 是否正常完成）",
      value: 0,
      environment: "test",
    }));
    expect(flushAsync).toHaveBeenCalledOnce();
  });
});
