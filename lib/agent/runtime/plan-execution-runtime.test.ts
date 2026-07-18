import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTrace } from "./trace";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import {
  AGENTIC_RAG_VERSION,
  type EvidenceBundle,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";

const { runAgentLoopMock } = vi.hoisted(() => ({
  runAgentLoopMock: vi.fn(),
}));

vi.mock("@/lib/agent/runtime", () => ({
  runAgentLoop: runAgentLoopMock,
}));

import { executePlan } from "./plan-execution";

function metrics() {
  return {
    estimatedTokensSpent: 0,
    modelCallCount: 1,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    actualTotalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    estimatedModelCostCny: 0,
    toolCallCount: 1,
    totalToolCost: 0,
    toolDurations: [],
  };
}

function bundle(): EvidenceBundle {
  return {
    bundleId: "evidence-plan",
    version: AGENTIC_RAG_VERSION,
    route: "knowledge",
    query: "RAG",
    indexVersion: "index-1",
    generatedAt: "2026-07-17T00:00:00.000Z",
    evidences: [],
    grade: {
      sufficient: false,
      grade: "none",
      reason: "no_results",
      topScore: null,
      scoreGap: null,
      queryCoverage: 0,
      acceptedEvidenceIds: [],
    },
    attempts: [],
  };
}

function retrievalPlan(): RetrievalPlan {
  return {
    id: "retrieval-plan",
    version: AGENTIC_RAG_VERSION,
    route: "knowledge",
    originalQuery: "先看时间，再查我的 RAG 笔记",
    standaloneQuery: "先看时间，再查我的 RAG 笔记",
    queryType: "multi-hop",
    reason: "explicit_private_knowledge_intent",
    confidence: 1,
    evidenceRequired: true,
    maxAttempts: 2,
    indexVersion: "index-1",
    steps: [{
      id: "knowledge-1",
      source: "knowledge",
      query: "RAG 笔记",
      purpose: "primary_retrieval",
    }],
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

describe("Plan-and-Execute runtime integration", () => {
  beforeEach(() => runAgentLoopMock.mockReset());

  it("aggregates evidence and allows each retrieval tool only once across plan steps", async () => {
    const firstTrace = createTrace("step-1");
    firstTrace.steps.push({
      type: "tool",
      index: 0,
      startedAt: 0,
      name: "search_notes",
      input: { query: "RAG" },
      ok: true,
      contentSummary: "no evidence",
      contentTruncated: false,
      contentOriginalChars: 11,
      costPerUse: 0,
    });
    runAgentLoopMock
      .mockResolvedValueOnce({
        loopMessages: [{ role: "assistant", content: "第一步完成" }],
        completed: true,
        stopReason: "completed",
        metrics: metrics(),
        trace: firstTrace,
        evidenceBundles: [bundle()],
      })
      .mockImplementationOnce(async (messages: unknown[]) => ({
        loopMessages: [...messages, { role: "assistant", content: "第二步完成" }],
        completed: true,
        stopReason: "completed",
        metrics: metrics(),
        trace: createTrace("step-2"),
        evidenceBundles: [],
      }));

    const result = await executePlan({
      messages: [{ role: "user", content: "执行计划" }],
      tools: [{
        name: "search_notes",
        description: "search",
        input_schema: { type: "object", properties: {} },
      }],
      toolRegistry: new ToolRegistry(),
      maxToolIterations: 4,
      allToolSources: [],
      requestId: "request-1",
    }, {
      id: "plan-1",
      objective: "检索并总结",
      steps: [
        { id: "one", goal: "检索", allowedTools: ["search_notes"], successCriteria: ["完成"] },
        { id: "two", goal: "复核", allowedTools: ["search_notes"], successCriteria: ["完成"] },
      ],
    });

    expect(result.evidenceBundles).toHaveLength(1);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    expect(runAgentLoopMock.mock.calls[0][1]).toHaveLength(1);
    expect(runAgentLoopMock.mock.calls[1][1]).toEqual([]);
  });

  it("does not apply the global retrieval plan to non-retrieval steps", async () => {
    runAgentLoopMock
      .mockResolvedValueOnce({
        loopMessages: [{ role: "assistant", content: "当前时间已获取" }],
        completed: true,
        stopReason: "completed",
        metrics: metrics(),
        trace: createTrace("time-step"),
        evidenceBundles: [],
      })
      .mockImplementationOnce(async (messages: unknown[]) => ({
        loopMessages: [...messages, { role: "assistant", content: "笔记已检索" }],
        completed: true,
        stopReason: "completed",
        metrics: metrics(),
        trace: createTrace("knowledge-step"),
        evidenceBundles: [],
      }));

    await executePlan({
      messages: [{ role: "user", content: "执行计划" }],
      tools: [
        { name: "get_current_time", description: "time", input_schema: { type: "object", properties: {} } },
        { name: "search_notes", description: "search", input_schema: { type: "object", properties: {} } },
      ],
      toolRegistry: new ToolRegistry(),
      maxToolIterations: 4,
      allToolSources: [],
      requestId: "request-scoped",
      retrievalPlan: retrievalPlan(),
    }, {
      id: "plan-scoped",
      objective: "先获取时间再检索笔记",
      steps: [
        { id: "time", goal: "获取当前时间", allowedTools: ["get_current_time"], successCriteria: ["获得时间"] },
        { id: "notes", goal: "检索笔记", allowedTools: ["search_notes"], successCriteria: ["获得证据"] },
      ],
    });

    expect(runAgentLoopMock.mock.calls[0][14]).toBeUndefined();
    expect(runAgentLoopMock.mock.calls[0][15]).toEqual([]);
    expect(runAgentLoopMock.mock.calls[1][14]).toMatchObject({
      route: "knowledge",
      evidenceRequired: true,
    });
  });
});
