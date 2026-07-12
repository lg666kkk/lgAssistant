import { describe, expect, it } from "vitest";
import { compactLoopMessages } from "./compaction";

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
