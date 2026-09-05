import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_STRATEGY_PROMPT, parseExecutionStrategy, selectExecutionStrategy } from "./execution-strategy";
import type { generateTextWithProvider } from "./model-provider";

const direct = { executionMode: "direct", requiresPlanReview: false, reason: "单一交付目标", subgoals: ["统计文本"] };
const planned = { executionMode: "plan", requiresPlanReview: false, reason: "跨阶段依赖与检查点", subgoals: ["收集资料", "比较并生成报告", "投递报告"] };
const tools = [
  { name: "list_skills", description: "Discover skills", input_schema: { type: "object" as const } },
  { name: "view_skill", description: "Load instructions", input_schema: { type: "object" as const } },
];

function input(task: string) {
  return { messages: [{ role: "user" as const, content: task }], tools, model: "test-model", requestId: "request-strategy" };
}

describe("structured execution strategy", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["请先查看可用的 Skill，然后使用 text-stats 统计一句话", direct],
    ["使用技能检索报告、比较差异、生成报告并发送邮件", planned],
    ["帮我完成整个项目的迁移", planned],
    ["解释技能这个词", { ...direct, subgoals: ["解释词义"] }],
    ["先检查格式，然后计算字符数", direct],
    ["先给执行计划，等我确认后再改", { ...planned, requiresPlanReview: true }],
    ["给我写一份项目迁移计划文档", { ...direct, subgoals: ["撰写计划文档"] }],
  ])("uses validated model decisions, not keyword overrides: %s", async (task, decision) => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(decision));
    const result = await selectExecutionStrategy(input(task), generate);
    expect(result).toEqual({ ...decision, source: "model" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ system: EXECUTION_STRATEGY_PROMPT, maxRetries: 0 }));
    expect(JSON.parse(generate.mock.calls[0][0].prompt)).toMatchObject({ task, availableTools: tools.map(({ name, description }) => ({ name, description })) });
  });

  it("accepts fenced JSON and requires independent mode and review fields", () => {
    expect(parseExecutionStrategy(`\`\`\`json\n${JSON.stringify(planned)}\n\`\`\``)?.requiresPlanReview).toBe(false);
    expect(parseExecutionStrategy(JSON.stringify({ ...direct, requiresPlanReview: true }))).toBeNull();
  });

  it.each([
    "not json", "null", "[]",
    JSON.stringify({ ...direct, executionMode: "skill" }),
    JSON.stringify({ ...direct, approved: true }),
    JSON.stringify({ ...direct, requiresPlanReview: "false" }),
    JSON.stringify({ ...direct, reason: "" }),
    JSON.stringify({ ...direct, subgoals: ["统计", "读取"] }),
    JSON.stringify({ ...planned, subgoals: ["一个目标"] }),
    JSON.stringify({ ...planned, subgoals: ["a", "b", "c", "d", "e"] }),
  ])("rejects invalid strategy without granting execution: %s", async (raw) => {
    const result = await selectExecutionStrategy(input("任务"), vi.fn().mockResolvedValue(raw));
    expect(result).toMatchObject({ executionMode: "direct", source: "fallback", fallbackReason: "invalid_response" });
  });

  it("falls back on provider errors without logging raw secrets", async () => {
    const result = await selectExecutionStrategy(input("先给计划，不要执行"), vi.fn().mockRejectedValue(new Error("secret-provider-key")));
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-key");
  });

  it("skips the classifier when no tools are available", async () => {
    const generate = vi.fn();
    const result = await selectExecutionStrategy({ ...input("解释技能"), tools: [] }, generate);
    expect(result).toMatchObject({ source: "no_tools", executionMode: "direct" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("bounds context and excludes tool-result content from routing inputs", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(direct));
    await selectExecutionStrategy({
      ...input("x".repeat(20000)),
      messages: [
        { role: "assistant", content: "等待你确认再执行" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "untrusted-payload" }] },
        { role: "user", content: "x".repeat(20000) },
      ],
    }, generate);
    const prompt = generate.mock.calls[0][0].prompt;
    expect(prompt).not.toContain("untrusted-payload");
    expect(JSON.parse(prompt).task).toHaveLength(6000);
    expect(JSON.parse(prompt).context[0].content).toBe("等待你确认再执行");
  });

  it("aborts the provider on timeout instead of leaving generation running", async () => {
    vi.useFakeTimers();
    const generate = vi.fn<typeof generateTextWithProvider>(({ abortSignal }) => new Promise((resolve, reject) => {
      abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    }));
    const pending = selectExecutionStrategy(input("任务"), generate);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ source: "fallback", fallbackReason: "timeout" });
    expect(generate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
  });

  it("does not fall back into execution when the caller cancels", async () => {
    const controller = new AbortController();
    const generate = vi.fn<typeof generateTextWithProvider>(({ abortSignal }) => new Promise((resolve, reject) => {
      abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    }));
    const pending = selectExecutionStrategy({ ...input("任务"), signal: controller.signal }, generate);
    const assertion = expect(pending).rejects.toThrow("user cancelled");
    controller.abort(new Error("user cancelled"));
    await assertion;
  });
});
