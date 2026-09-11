import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTrace } from "./trace";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { defaultToolRuntimePolicy } from "@/lib/agent/tools/types";
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

  it("preserves a failed step as a failed plan awaiting only a final explanation", async () => {
    runAgentLoopMock.mockResolvedValue({
      loopMessages: [{ role: "assistant", content: "部分结果" }], completed: false,
      stopReason: "max_iterations", metrics: metrics(), trace: createTrace("failed-step"),
    });
    const result = await executePlan({
      messages: [{ role: "user", content: "执行计划" }], tools: [], toolRegistry: new ToolRegistry(),
      maxToolIterations: 1, allToolSources: [], requestId: "failure",
    }, {
      id: "plan", objective: "执行计划", steps: [
        { id: "one", goal: "读取", allowedTools: [], successCriteria: ["读取完成"] },
        { id: "two", goal: "写入", allowedTools: [], successCriteria: ["写入完成"] },
      ],
    });
    expect(result.trace).toMatchObject({ completed: false, stopReason: "error" });
    expect(result.stopReason).toBe("error");
    expect(runAgentLoopMock).toHaveBeenCalledOnce();
  });

  it("propagates pending tool confirmation without continuing the plan", async () => {
    const pendingTrace = createTrace("todo-step");
    pendingTrace.steps.push({
      type: "tool",
      index: 0,
      startedAt: 0,
      name: "create_todo",
      input: { title: "提交周报" },
      ok: false,
      error: "Tool requires approval: create_todo",
      contentSummary: "需要用户确认",
      contentTruncated: false,
      contentOriginalChars: 6,
      metadata: { status: "pending_confirmation" },
      costPerUse: 0,
    });
    runAgentLoopMock.mockResolvedValueOnce({
      loopMessages: [{ role: "assistant", content: "待确认" }],
      completed: true,
      stopReason: "awaiting_tool_confirmation",
      metrics: metrics(),
      trace: pendingTrace,
      evidenceBundles: [],
    });

    const result = await executePlan({
      messages: [{ role: "user", content: "创建一个提交周报的待办" }],
      tools: [{
        name: "create_todo",
        description: "todo",
        input_schema: { type: "object", properties: {} },
      }],
      toolRegistry: createBuiltinToolRegistry(),
      maxToolIterations: 4,
      allToolSources: [],
      requestId: "request-todo",
    }, {
      id: "plan-todo",
      objective: "创建待办",
      steps: [{
        id: "create",
        goal: "创建待办",
        allowedTools: ["create_todo"],
        successCriteria: ["待办已创建"],
      }],
    });

    expect(result.completed).toBe(true);
    expect(result.stopReason).toBe("awaiting_tool_confirmation");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

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
      toolRegistry: createBuiltinToolRegistry(),
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

  it("shares a two-call retrieval budget across all plan steps", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "web_search",
      description: "search web",
      capabilities: ["public.search"],
      outputPolicy: {
        grounding: "cited_evidence",
        citationRequired: true,
        retrieval: { source: "web", maxCallsPerRun: 2 },
      },
      input_schema: { type: "object", properties: {} },
      riskLevel: "safe",
      runtime: defaultToolRuntimePolicy,
      execute: vi.fn(),
    });
    const initialUsage: number[] = [];
    runAgentLoopMock.mockImplementation(async (...args: any[]) => {
      const tools = (args[1] ?? []) as Array<{ name: string }>;
      const used = args[19] as ReadonlyMap<string, number> | undefined;
      initialUsage.push(used?.get("web_search") ?? 0);
      const trace = createTrace(`step-${initialUsage.length}`);
      if (tools.some((tool) => tool.name === "web_search")) {
        trace.steps.push({
          type: "tool",
          index: 0,
          startedAt: 0,
          name: "web_search",
          input: { query: `query-${initialUsage.length}` },
          ok: true,
          contentSummary: "evidence",
          contentTruncated: false,
          contentOriginalChars: 8,
          costPerUse: 0,
        });
      }
      return {
        loopMessages: [...(args[0] ?? []), { role: "assistant", content: "完成" }],
        completed: true,
        stopReason: "completed",
        metrics: metrics(),
        trace,
        evidenceBundles: [],
      };
    });

    await executePlan({
      messages: [{ role: "user", content: "分三步检索" }],
      tools: [{ name: "web_search", description: "search", input_schema: { type: "object", properties: {} } }],
      toolRegistry: registry,
      maxToolIterations: 3,
      allToolSources: [],
      requestId: "request-two-web-searches",
    }, {
      id: "plan-two-web-searches",
      objective: "最多检索两次",
      steps: [
        { id: "one", goal: "首次检索", allowedTools: ["web_search"], successCriteria: ["完成"] },
        { id: "two", goal: "补充检索", allowedTools: ["web_search"], successCriteria: ["完成"] },
        { id: "three", goal: "再次检索", allowedTools: ["web_search"], successCriteria: ["完成"] },
      ],
    });

    expect(initialUsage).toEqual([0, 1, 2]);
    expect(runAgentLoopMock.mock.calls.map((call) => call[1].map((tool: any) => tool.name)))
      .toEqual([["web_search"], ["web_search"], []]);
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
      toolRegistry: createBuiltinToolRegistry(),
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

  it("passes the same context plan to every executor step", async () => {
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => ({
      loopMessages: [
        ...(Array.isArray(args[0]) ? args[0] : []),
        { role: "assistant", content: "完成" },
      ],
      completed: true,
      stopReason: "completed",
      metrics: metrics(),
      trace: createTrace("step"),
      evidenceBundles: [],
    }));
    const contextPlan = {
      id: "context-plan-1",
      snapshotId: "snapshot-1",
      policy: { id: "default-chat", version: "1" },
      model: "deepseek-v4-flash",
      windowTokens: 32_000,
      outputReserveTokens: 4_096,
      history: { source: "snapshot" as const, originalMessages: 2, keptMessages: 2 },
      sources: [],
      totals: { systemTokens: 0, messageTokens: 2, toolSchemaTokens: 0, totalTokens: 2 },
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    const result = await executePlan({
      messages: [{ role: "user", content: "先分析再总结" }],
      tools: [],
      toolRegistry: new ToolRegistry(),
      maxToolIterations: 2,
      allToolSources: [],
      requestId: "request-context",
      contextPlan,
    }, {
      id: "plan-context",
      objective: "分析总结",
      steps: [
        { id: "one", goal: "分析", allowedTools: [], successCriteria: ["完成"] },
        { id: "two", goal: "总结", allowedTools: [], successCriteria: ["完成"] },
      ],
    });
    expect(result.trace.contextPlan?.id).toBe("context-plan-1");
    expect(runAgentLoopMock.mock.calls.every((call) => call[16]?.id === "context-plan-1")).toBe(true);
  });
});
