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
      webSearchEnabled: true,
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
});
