import { describe, expect, it, vi } from "vitest";
import { buildRetrievalPlan } from "@/lib/agent/rag/retrieval-router";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { defaultToolRuntimePolicy, type ToolResult } from "@/lib/agent/tools/types";
import { AGENTIC_RAG_VERSION, type EvidenceBundle } from "@/lib/agent/rag/types";
import { callModel, runAgentLoop } from "./index";

function webBundle(): EvidenceBundle {
  return {
    bundleId: "bundle-web-test",
    version: AGENTIC_RAG_VERSION,
    route: "web",
    query: "Next.js 最新版本",
    indexVersion: "web-test",
    generatedAt: "2026-07-26T00:00:00.000Z",
    evidences: [{
      evidenceId: "ev_aaaaaaaaaaaa",
      source: "web",
      chunkId: "web-1",
      documentId: "https://nextjs.org/blog",
      documentVersion: "v1",
      title: "Next.js 15",
      content: "Next.js 15 已经发布。",
      scores: { rerank: 0.8 },
      trustLevel: "public_primary",
      citation: { url: "https://nextjs.org/blog", startChar: 0, endChar: 12 },
    }],
    grade: {
      sufficient: true,
      grade: "strong",
      reason: "strong_single_evidence",
      topScore: 0.8,
      scoreGap: null,
      queryCoverage: 1,
      acceptedEvidenceIds: ["ev_aaaaaaaaaaaa"],
    },
    attempts: [],
  };
}

describe("runtime tool grounding", () => {
  it("accepts a successful authoritative tool result without RAG evidence", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "get_current_time",
      description: "current time",
      capabilities: ["time.current"],
      outputPolicy: { grounding: "authoritative_result", citationRequired: false },
      input_schema: { type: "object", properties: {} },
      riskLevel: "safe",
      runtime: { ...defaultToolRuntimePolicy, sideEffect: "none" },
      execute: vi.fn(async () => ({
        ok: true,
        content: "当前时间：2026年7月26日星期日 12:00:00",
      })),
    });
    const callModelMock = vi.fn()
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "time-1",
          name: "get_current_time",
          input: {},
        }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "今天是2026年7月26日。" }],
        stop_reason: "end_turn",
      });

    const result = await runAgentLoop(
      [{ role: "user", content: "今天几号" }],
      registry.listForModel(),
      registry,
      3,
      [],
      () => true,
      "request-time-grounding",
      "session-time-grounding",
      { callModel: callModelMock as unknown as typeof callModel },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      buildRetrievalPlan({ query: "今天几号", webEnabled: true }),
    );

    expect(result.completed).toBe(true);
    expect(result.usedGroundingModes).toEqual(["authoritative_result"]);
    expect(result.toolEvidenceRequired).toBe(false);
    expect(JSON.stringify(result.loopMessages)).toContain("今天是2026年7月26日");
    expect(JSON.stringify(result.loopMessages)).not.toContain("未获得足够证据");
    expect(result.trace.steps).toContainEqual(expect.objectContaining({
      type: "tool",
      metadata: expect.objectContaining({
        grounding: "authoritative_result",
        citationRequired: false,
      }),
    }));
  });

  function citedEvidenceRegistry(result: ToolResult) {
    const registry = new ToolRegistry();
    registry.register({
      name: "web_search",
      description: "web search",
      capabilities: ["public.search"],
      outputPolicy: {
        grounding: "cited_evidence",
        citationRequired: true,
        retrieval: { source: "web", maxCallsPerRun: 1 },
      },
      input_schema: { type: "object", properties: {} },
      riskLevel: "safe",
      runtime: { ...defaultToolRuntimePolicy, sideEffect: "read" },
      execute: vi.fn(async () => result),
    });
    return registry;
  }

  function searchThenAnswer(answer: string) {
    return vi.fn()
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "search-1",
          name: "web_search",
          input: { query: "Next.js 最新版本" },
        }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: answer }],
        stop_reason: "end_turn",
      });
  }

  function runWebSearchLoop(
    registry: ToolRegistry,
    callModelMock: ReturnType<typeof vi.fn>,
    planQuery = "Next.js 最新版本是什么",
  ) {
    return runAgentLoop(
      [{ role: "user", content: "Next.js 最新版本是什么" }],
      registry.listForModel(),
      registry,
      3,
      [],
      () => true,
      "request-web-grounding",
      "session-web-grounding",
      { callModel: callModelMock as unknown as typeof callModel },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      buildRetrievalPlan({ query: planQuery, webEnabled: true }),
    );
  }

  it("records failed evidence validation without changing the model answer", async () => {
    const registry = citedEvidenceRegistry({
      ok: true,
      content: "1. [ev_aaaaaaaaaaaa] Next.js 15",
      data: { evidenceBundle: webBundle() },
    });
    const result = await runWebSearchLoop(registry, searchThenAnswer("模型尝试直接回答。"));

    expect(result.toolEvidenceRequired).toBe(true);
    expect(result.usedGroundingModes).toEqual(["cited_evidence"]);
    expect(JSON.stringify(result.loopMessages)).toContain("模型尝试直接回答。");
    expect(result.trace.steps).toContainEqual(expect.objectContaining({
      type: "answer_validation",
      guarded: false,
      report: expect.objectContaining({ status: "fail" }),
    }));
  });

  // 检索工具查不到内容时也返回 ok:true。工具级 evidenceRequired 的判据仍应是
  // “拿到了证据”，而不是“调用成功”，这样 Trace 能区分空结果和漏写引用。
  it("does not require citations when the retrieval tool came back empty", async () => {
    const registry = citedEvidenceRegistry({ ok: true, content: "没有找到结果" });
    const result = await runWebSearchLoop(registry, searchThenAnswer("没有检索到相关资料。"));

    expect(result.toolEvidenceRequired).toBe(false);
    expect(JSON.stringify(result.loopMessages)).toContain("没有检索到相关资料");
    expect(JSON.stringify(result.loopMessages)).not.toContain("未获得足够证据");
  });

  it("keeps the original answer when required retrieval returns no evidence", async () => {
    const registry = citedEvidenceRegistry({ ok: true, content: "没有找到结果" });
    const answer = "没有检索到资料，但这是模型生成的原始回答。";
    const result = await runWebSearchLoop(
      registry,
      searchThenAnswer(answer),
      "联网查询 Next.js 官方文档",
    );

    expect(JSON.stringify(result.loopMessages)).toContain(answer);
    expect(JSON.stringify(result.loopMessages)).not.toContain("无法可靠回答");
    expect(result.trace.steps).toContainEqual(expect.objectContaining({
      type: "answer_validation",
      guarded: false,
      report: expect.objectContaining({
        status: "fail",
        evidenceRequired: true,
        evidenceCount: 0,
      }),
    }));
  });

  it("enforces active orchestration prerequisites before tool execution", async () => {
    const timeExecute = vi.fn(async () => ({ ok: true, content: "2026-07-26" }));
    const webExecute = vi.fn(async () => ({ ok: true, content: "search completed" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "get_current_time",
      description: "current time",
      capabilities: ["time.current"],
      outputPolicy: { grounding: "authoritative_result", citationRequired: false },
      input_schema: { type: "object", properties: {} },
      riskLevel: "safe",
      runtime: { ...defaultToolRuntimePolicy, sideEffect: "none" },
      execute: timeExecute,
    });
    registry.register({
      name: "web_search",
      description: "web search",
      capabilities: ["public.search"],
      outputPolicy: {
        grounding: "authoritative_result",
        citationRequired: false,
        retrieval: { source: "web", maxCallsPerRun: 1 },
      },
      orchestration: {
        prerequisites: ["time.current"],
        invokeWhen: "public_freshness_required",
      },
      input_schema: { type: "object", properties: {} },
      riskLevel: "safe",
      runtime: { ...defaultToolRuntimePolicy, sideEffect: "external" },
      execute: webExecute,
    });
    const callModelMock = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "web-too-early", name: "web_search", input: {} }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "time-first", name: "get_current_time", input: {} }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "web-after-time", name: "web_search", input: {} }],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "已基于搜索结果回答。" }],
        stop_reason: "end_turn",
      });

    const result = await runAgentLoop(
      [{ role: "user", content: "查询最新 Next.js 版本" }],
      registry.listForModel(),
      registry,
      4,
      [],
      () => true,
      "request-orchestration",
      "session-orchestration",
      { callModel: callModelMock as unknown as typeof callModel },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      buildRetrievalPlan({ query: "查询最新 Next.js 版本", webEnabled: true }),
    );

    expect(result.completed).toBe(true);
    expect(timeExecute).toHaveBeenCalledTimes(1);
    expect(webExecute).toHaveBeenCalledTimes(1);
    expect(result.usedCapabilities).toEqual(expect.arrayContaining([
      "time.current",
      "public.search",
    ]));
    expect(result.trace.steps).toContainEqual(expect.objectContaining({
      type: "tool",
      name: "web_search",
      ok: false,
      metadata: expect.objectContaining({
        status: "orchestration_prerequisite_missing",
        missingCapabilities: ["time.current"],
      }),
    }));
  });
});
