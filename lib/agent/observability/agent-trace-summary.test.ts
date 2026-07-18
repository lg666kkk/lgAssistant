import { describe, expect, it } from "vitest";
import { summarizeCompaction, summarizeRagRoute } from "./agent-trace-summary";

describe("agent trace Langfuse summaries", () => {
  it("keeps RAG route summaries free of the original query", () => {
    const summary = summarizeRagRoute({
      id: "retrieval-1",
      version: "agentic-rag-v2",
      route: "knowledge",
      originalQuery: "我的私密问题",
      standaloneQuery: "我的私密问题",
      queryType: "semantic",
      reason: "private knowledge request",
      confidence: 0.9,
      evidenceRequired: true,
      maxAttempts: 2,
      indexVersion: "index-1",
      steps: [{ id: "knowledge-1", source: "knowledge", query: "我的私密问题", purpose: "primary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(summary).toMatchObject({ route: "knowledge", plannedStepCount: 1 });
    expect(JSON.stringify(summary)).not.toContain("我的私密问题");
  });

  it("reports compaction reduction without including the summary text", () => {
    const summary = summarizeCompaction({
      type: "context_compaction",
      index: 0,
      startedAt: 1,
      durationMs: 20,
      beforeTokens: 1_000,
      afterTokens: 400,
      modelWindowTokens: 8_000,
      triggerTokens: 6_000,
      targetTokens: 4_000,
      primerMessages: 3,
      recentMessages: 6,
      middleMessageCount: 8,
      reason: "semantic_context_compaction",
      summary: "private summary text",
      summaryChars: 20,
      method: "semantic",
    });

    expect(summary).toMatchObject({ tokenReduction: 600, tokenReductionRatio: 0.6 });
    expect(JSON.stringify(summary)).not.toContain("private summary text");
  });
});
