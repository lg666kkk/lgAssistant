import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { assertRequestContextFits, getRequestContextLimits, prepareRequestContext } from "./request-context";

describe("model request context", () => {
  it("reserves the configured output and safety margin, independent of history", () => {
    const limits = getRequestContextLimits(32000, 8192);
    expect(limits.inputLimitTokens).toBe(23296);
    const large = getRequestContextLimits(128000, 8192);
    expect(large.workingWindowTokens).toBe(80000);
    expect(large.inputLimitTokens).toBe(71008);
  });

  it("reuses the same history when switching models and does not mutate it", () => {
    const messages: Anthropic.MessageParam[] = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: index === 17 ? "当前任务必须保留" : "older detail ".repeat(500),
    }));
    const original = JSON.stringify(messages);
    const large = prepareRequestContext({ messages, tools: [], contextWindow: 128000, maxOutputTokens: 4096 });
    const small = prepareRequestContext({ messages, tools: [], contextWindow: 16000, maxOutputTokens: 4096 });
    expect(large.canFit).toBe(true);
    expect(small.canFit).toBe(true);
    expect(small.compacted).toBe(true);
    expect(small.estimatedTokens).toBeLessThan(large.estimatedTokens);
    expect(small.messages[small.messages.length - 1].content).toBe("当前任务必须保留");
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("blocks an oversized latest input rather than silently deleting it", () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "current task ".repeat(12000) }];
    const result = prepareRequestContext({ messages, tools: [], contextWindow: 16000, maxOutputTokens: 4096 });
    expect(result.canFit).toBe(false);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(() => assertRequestContextFits(result)).toThrow("上下文容量");
  });

  it("includes tool schema and system overhead in the capacity check", () => {
    const result = prepareRequestContext({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "large", description: "schema overhead ".repeat(14000), input_schema: { type: "object", properties: {} } }],
      system: "system",
      contextWindow: 32000, maxOutputTokens: 4096,
    });
    expect(result.canFit).toBe(false);
    expect(result.availableInputTokens).toBe(0);
  });
});
