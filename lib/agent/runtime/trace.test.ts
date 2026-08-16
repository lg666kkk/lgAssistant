import { describe, it, expect } from "vitest";
import { createTrace, formatTraceTree, prependMemoryRecallTraceStep } from "./trace";

describe("trace 冒烟测试", () => {
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
});
