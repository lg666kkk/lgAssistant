import { describe, expect, it } from "vitest";
import { buildContextPlan } from "./plan";
import { createContextSnapshot } from "./snapshot-store";
import { buildPromptPipe } from "@/lib/agent/prompt/pipe";

describe("context plan and snapshot", () => {
  it("records selection decisions without storing source content", () => {
    const prompt = buildPromptPipe({ memory: "candidate memory", maxTokens: 500 });
    const plan = buildContextPlan({
      model: "deepseek-v4-flash",
      windowTokens: 32_000,
      outputReserveTokens: 4_096,
      messages: [{ role: "user", content: "hello" }],
      originalMessageCount: 1,
      historySource: "client",
      tools: [],
      prompt,
    });
    expect(plan.sources.some((source) => source.kind === "memory" && source.trust === "external")).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("candidate memory");
  });

  it("does not let the model claim an asynchronous memory write already succeeded", () => {
    const prompt = buildPromptPipe({ maxTokens: 500 });

    expect(prompt.systemPrompt).toContain("后台沉淀尚未返回成功回执时");
    expect(prompt.systemPrompt).toContain("本轮结束后会尝试更新长期记忆");
  });

  it("versions snapshots and preserves the previous id", () => {
    const first = createContextSnapshot({
      userId: "user-1",
      sessionId: "session-1",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "goal" }],
    });
    const second = createContextSnapshot({
      previous: first,
      userId: "user-1",
      sessionId: "session-1",
      model: "deepseek-v4-flash",
      messages: [...first.messages, { role: "assistant", content: "done" }],
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.contentHash).not.toBe(first.contentHash);
  });
});
