import { describe, it, expect } from "vitest";
import {
  createTrace,
  formatTraceTree,
  prependMemoryRecallTraceStep,
  prependUserProfileTraceStep,
} from "./trace";

describe("trace 冒烟测试", () => {
  it("records the execution strategy independently from tool authorization", () => {
    const trace = createTrace("strategy-1");
    trace.steps.push({
      type: "execution_strategy", index: 0, startedAt: 1, durationMs: 10,
      executionMode: "plan", requiresPlanReview: false, reason: "跨阶段目标", subgoals: ["读取", "生成"],
      subgoalCount: 2, source: "model", toolsSuppressed: false, planGenerationFailed: false,
    });
    expect(formatTraceTree(trace)).toContain("execution_strategy mode=plan review=false subgoals=2 source=model toolsSuppressed=false");
  });
  it("createTrace 初始化一棵空树", () => {
    const t = createTrace("req-1");
    expect(t.requestId).toBe("req-1");
    expect(t.steps).toEqual([]);
    expect(t.completed).toBe(false);
  });

  it("renders memory rerank data as a dedicated trace step", () => {
    const trace = createTrace("req-memory");
    prependMemoryRecallTraceStep(trace, {
      type: "memory_recall",
      startedAt: 1,
      durationMs: 42,
      query: "我的预算是多少",
      eligible: true,
      candidateCount: 2,
      selectedCount: 1,
      selectedTypes: { fact: 1 },
      selectedSources: { user_explicit: 1 },
      rerank: {
        enabled: true,
        configured: true,
        mode: "always",
        model: "qwen3-rerank",
        instruct: "Retrieve relevant memories.",
        candidateCount: 2,
        candidateLimit: 12,
        admitThreshold: 0.6,
        used: true,
        reason: "mode_always",
        latencyMs: 40,
        candidates: [],
      },
    });

    expect(formatTraceTree(trace)).toContain("memory_recall eligible=true selected=1 rerank=used");
  });

  it("prepends memory recall and reindexes existing steps", () => {
    const trace = createTrace("req-memory-order");
    trace.steps.push({
      type: "model",
      index: 0,
      startedAt: 2,
      textSummary: "ok",
      textTruncated: false,
      textOriginalChars: 2,
      requestedToolCalls: [],
      estimatedContextTokens: 1,
    });
    prependMemoryRecallTraceStep(trace, {
      type: "memory_recall",
      startedAt: 1,
      query: "预算",
      eligible: false,
      candidateCount: 0,
      selectedCount: 0,
      selectedTypes: {},
      selectedSources: {},
      rerank: {
        enabled: false,
        configured: false,
        mode: "conditional",
        model: "qwen3-rerank",
        instruct: "Retrieve relevant memories.",
        candidateCount: 0,
        candidateLimit: 12,
        admitThreshold: null,
        used: false,
        reason: "disabled",
        latencyMs: 0,
        candidates: [],
      },
    });

    expect(trace.steps.map((step) => [step.type, step.index])).toEqual([
      ["memory_recall", 0],
      ["model", 1],
    ]);
  });

  it("records the injected user profile as a dedicated first trace step", () => {
    const trace = createTrace("req-profile");
    trace.steps.push({
      type: "model",
      index: 0,
      startedAt: 2,
      textSummary: "ok",
      textTruncated: false,
      textOriginalChars: 2,
      requestedToolCalls: [],
      estimatedContextTokens: 1,
    });

    prependUserProfileTraceStep(trace, {
      type: "user_profile",
      startedAt: 1,
      configured: true,
      injected: true,
      revision: 4,
      updatedAt: "2026-08-28T00:00:00.000Z",
      contentChars: 20,
      injectedChars: 80,
      content: "<user_profile>\n先给结论\n</user_profile>",
    });

    expect(trace.steps.map((step) => [step.type, step.index])).toEqual([
      ["user_profile", 0],
      ["model", 1],
    ]);
    expect(formatTraceTree(trace)).toContain("user_profile configured=true injected=true revision=4 chars=80");
  });
});
