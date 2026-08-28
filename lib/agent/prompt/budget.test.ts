import { describe, expect, it } from "vitest";
import { countTokensFromText } from "@/lib/agent/runtime/tokenizer";
import { applyPromptBudget } from "./budget";
import { buildPromptPipe } from "./pipe";
import type { PromptSegment } from "./segments";

function segment(content: string, tokenBudget: number): PromptSegment {
  return {
    kind: "memory",
    title: "测试",
    content,
    priority: 1,
    tokenBudget,
  };
}

describe("prompt hard budget", () => {
  it("enforces each segment budget before the global budget", () => {
    const result = applyPromptBudget([
      segment("中文上下文".repeat(200), 32),
      segment("second ".repeat(100), 24),
    ], { maxTokens: 80 });

    expect(countTokensFromText(result.kept[0].content)).toBeLessThanOrEqual(32);
    expect(countTokensFromText(result.kept[1].content)).toBeLessThanOrEqual(24);
    expect(result.estimatedTokens).toBeLessThanOrEqual(80);
    expect(result.decisions.every((decision) => decision.decision === "truncated")).toBe(true);
  });

  it("counts rendered separators in the global budget", () => {
    const prompt = buildPromptPipe({
      memory: "memory ".repeat(500),
      maxTokens: 120,
    });
    expect(countTokensFromText(prompt.systemPrompt)).toBeLessThanOrEqual(120);
    expect(prompt.estimatedTokens).toBe(countTokensFromText(prompt.systemPrompt));
  });

  it("does not duplicate user text into the system prompt", () => {
    const userText = "这是只能保留在 user role 的内容";
    const prompt = buildPromptPipe({ userMessage: userText, maxTokens: 500 });
    expect(prompt.systemPrompt).not.toContain(userText);
    expect(prompt.segments.some((item) => item.source === "user")).toBe(false);
  });

  it("requires reasoning and answers to follow the user's language", () => {
    const prompt = buildPromptPipe({
      userMessage: "请分析这个问题",
      maxTokens: 500,
    });

    expect(prompt.systemPrompt).toContain("与用户当前消息相同的主要语言");
    expect(prompt.systemPrompt).toContain("思考过程（reasoning_content）和最终回答都必须使用中文");
  });

  it("includes memory operation results as trusted runtime context", () => {
    const prompt = buildPromptPipe({
      memoryOperation: "系统已完成忘记请求：1 条记忆已软失效。",
      maxTokens: 500,
    });
    expect(prompt.systemPrompt).toContain("1 条记忆已软失效");
    expect(prompt.segments).toContainEqual(expect.objectContaining({
      kind: "memory-operation",
      source: "runtime",
      trust: "trusted",
    }));
  });

  it("injects the user-maintained profile as a distinct, budgeted segment", () => {
    const prompt = buildPromptPipe({
      userProfile: "# 关于我\n\n- 称呼：小林\n- 偏好：先给结论",
      userProfileMetadata: { revision: 3 },
      maxTokens: 1_000,
    });

    expect(prompt.systemPrompt).toContain("<user_profile>");
    expect(prompt.systemPrompt).toContain("先给结论");
    expect(prompt.segments).toContainEqual(expect.objectContaining({
      kind: "user-profile",
      title: "用户画像",
      source: "user-profile",
      trust: "user",
      metadata: { revision: 3 },
    }));
  });

  it("does not create a user profile segment when the profile is empty", () => {
    const prompt = buildPromptPipe({ userProfile: "   ", maxTokens: 500 });
    expect(prompt.segments.some((segment) => segment.kind === "user-profile")).toBe(false);
  });

  it("does not inject tool-specific routing instructions", () => {
    const prompt = buildPromptPipe({
      retrievalPlan: {
        id: "retrieval-test",
        version: "agentic-rag-v2",
        route: "web",
        originalQuery: "最新版本",
        standaloneQuery: "最新版本",
        queryType: "balanced",
        reason: "fresh_or_public_information_required",
        confidence: 0.9,
        evidenceRequired: false,
        maxAttempts: 2,
        indexVersion: "web-live",
        steps: [],
        createdAt: "2026-07-26T00:00:00.000Z",
      },
      maxTokens: 1_000,
    });

    expect(prompt.systemPrompt).not.toContain("调用 web_search 前");
    expect(prompt.systemPrompt).not.toContain("如果 get_current_time");
    expect(prompt.systemPrompt).not.toContain("search_notes 是用户个人知识库检索工具");
    expect(prompt.segments.map((segment) => segment.kind)).toEqual([
      "identity",
      "evidence-policy",
      "retrieval-plan",
    ]);
  });

  it("injects registry-generated orchestration when web search is enabled", () => {
    const prompt = buildPromptPipe({
      webSearchEnabled: true,
      toolOrchestration: "调用 web_search 前必须先完成 time.current。",
      maxTokens: 1_000,
    });

    expect(prompt.systemPrompt).toContain("time.current");
    expect(prompt.segments).toContainEqual(expect.objectContaining({
      kind: "tool-orchestration",
      source: "runtime",
      trust: "trusted",
    }));
  });

  it("states web retrieval is fallback-only when knowledge route runs with web enabled", () => {
    const knowledgePlan = {
      id: "retrieval-knowledge",
      version: "agentic-rag-v2" as const,
      route: "knowledge" as const,
      originalQuery: "我之前写的 RAG 笔记",
      standaloneQuery: "我之前写的 RAG 笔记",
      queryType: "balanced" as const,
      reason: "knowledge_profile_match",
      confidence: 0.72,
      evidenceRequired: false,
      maxAttempts: 2,
      indexVersion: "index-1",
      steps: [],
      createdAt: "2026-07-26T00:00:00.000Z",
    };

    const withWeb = buildPromptPipe({
      retrievalPlan: knowledgePlan,
      webSearchEnabled: true,
      maxTokens: 1_000,
    });
    expect(withWeb.systemPrompt).toContain("仅作兜底");
    expect(withWeb.systemPrompt).toContain("必须先查个人知识库");

    // 联网关闭时 Web 工具本就不可见，不需要也不应该提兜底顺序。
    const withoutWeb = buildPromptPipe({
      retrievalPlan: knowledgePlan,
      webSearchEnabled: false,
      maxTokens: 1_000,
    });
    expect(withoutWeb.systemPrompt).not.toContain("仅作兜底");
  });
});
