import { describe, expect, it } from "vitest";
import { mergeMemoryConsolidationTraceStep } from "./trace-store";
import type { MemoryConsolidationTraceStep, TraceStep } from "./trace";

function memoryStep(persistedCount: number): Omit<MemoryConsolidationTraceStep, "index"> {
  return {
    type: "memory_consolidation",
    startedAt: 100,
    durationMs: 20,
    outcome: {
      status: "completed",
      extractedFactCount: 1,
      persistedCount,
      invalidatedCount: 0,
      purgedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      retriedCount: 0,
      decisions: { ADD: 1 },
      candidateDetails: [],
    },
  };
}

describe("trace-store memory consolidation merge", () => {
  it("appends one step and replaces a previous consolidation result idempotently", () => {
    const modelStep = {
      type: "model",
      index: 0,
      startedAt: 1,
      textSummary: "ok",
      textTruncated: false,
      textOriginalChars: 2,
      requestedToolCalls: [],
      estimatedContextTokens: 1,
    } satisfies TraceStep;

    const first = mergeMemoryConsolidationTraceStep([modelStep], memoryStep(1));
    const second = mergeMemoryConsolidationTraceStep(first, memoryStep(2));

    expect(second).toHaveLength(2);
    expect(second[1]).toMatchObject({
      type: "memory_consolidation",
      index: 1,
      outcome: { persistedCount: 2 },
    });
  });
});
