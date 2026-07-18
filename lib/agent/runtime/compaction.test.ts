import { describe, expect, it } from "vitest";
import {
  CONTEXT_SUMMARY_MARKER,
  compactLoopMessages,
  groupMessagesForCompaction,
  summarizeMessage,
} from "./compaction";

const messages = [
  { role: "user" as const, content: "最初需求" },
  { role: "assistant" as const, content: "初步方案" },
  { role: "user" as const, content: "补充约束" },
  { role: "assistant" as const, content: "执行结果" },
  { role: "user" as const, content: "当前问题" },
];

describe("context compaction force mode", () => {
  it("低于常规阈值时保持原消息", () => {
    const result = compactLoopMessages(messages, {
      modelWindowTokens: 10_000,
      triggerRatio: 0.9,
      primerMessages: 1,
      recentMessages: 1,
    });

    expect(result.compacted).toBe(false);
    expect(result.skippedReason).toBe("below_threshold");
  });

  it("force 模式绕过阈值和压缩频率限制", () => {
    const result = compactLoopMessages(messages, {
      modelWindowTokens: 10_000,
      triggerRatio: 0.9,
      primerMessages: 1,
      recentMessages: 1,
      lastCompactedMessageCount: messages.length,
      force: true,
    });

    expect(result.compacted).toBe(true);
    expect(result.middleMessageCount).toBeGreaterThan(0);
    expect(result.messages).toHaveLength(3);
  });
});

describe("context compaction integrity", () => {
  it("keeps tool_use and tool_result in one atomic group", () => {
    const transaction = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "call-1", name: "search", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "call-1", content: "ok" }] },
    ];
    const groups = groupMessagesForCompaction([
      { role: "user", content: "start" },
      ...transaction,
      { role: "assistant", content: "done" },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toEqual(transaction);
  });

  it("does not leave orphan tool results after compaction", () => {
    const toolUse = { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "call-1", name: "search", input: {} }] };
    const toolResult = { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "call-1", content: "ok" }] };
    const result = compactLoopMessages([
      { role: "user", content: "goal" },
      { role: "assistant", content: "plan" },
      toolUse,
      toolResult,
      { role: "assistant", content: "analysis" },
      { role: "user", content: "next" },
    ], { modelWindowTokens: 10_000, primerMessages: 1, recentMessages: 2, force: true });
    const serialized = JSON.stringify(result.messages);
    expect(serialized.includes("tool_result")).toBe(serialized.includes("tool_use"));
  });

  it("preserves prior summaries and artifact references in the digest", () => {
    const prior = { role: "user" as const, content: `${CONTEXT_SUMMARY_MARKER}\n${"重要目标和约束".repeat(20)}` };
    expect(summarizeMessage(prior, 0)).toContain("重要目标和约束".repeat(10));
    const tool = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "x", content: `${"long ".repeat(100)} artifact_id: web_abc123` }],
    };
    expect(summarizeMessage(tool, 1)).toContain("artifact_id: web_abc123");
  });

  it("preserves early constraints across repeated compactions", () => {
    const first = compactLoopMessages([
      { role: "user", content: "目标：发布前必须人工审批" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "约束代号 KEEP-APPROVAL" },
      { role: "assistant", content: "处理中" },
      { role: "user", content: "继续" },
    ], { modelWindowTokens: 10_000, primerMessages: 1, recentMessages: 1, force: true });
    const second = compactLoopMessages([
      ...first.messages,
      { role: "assistant", content: "新结果一" },
      { role: "user", content: "新问题一" },
      { role: "assistant", content: "新结果二" },
      { role: "user", content: "新问题二" },
    ], { modelWindowTokens: 10_000, primerMessages: 1, recentMessages: 1, force: true });
    expect(JSON.stringify(second.messages)).toContain("KEEP-APPROVAL");
  });
});
