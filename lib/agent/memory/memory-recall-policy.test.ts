import { describe, expect, it } from "vitest";
import { recallForPromptWithStats, renderMemoryPrefetchHint, shouldRecallLongTermMemory } from "./memory-flow";
import type { MemoryExecutionConfig } from "@/lib/memory-config/types";

const disabledConfig: MemoryExecutionConfig = {
  enabled: false,
  recallLimit: 3,
  recallThreshold: 0.68,
  writeConfidence: 0.72,
  ambiguousCandidateThreshold: 0.85,
  keywordAdmitThreshold: 0.5,
  fusionStrategy: "weighted",
  rerank: {
    enabled: false,
    configured: false,
    mode: "always",
    model: "qwen3-rerank",
    instruct: "test",
    candidateCount: 12,
    timeoutMs: 1200,
  },
};

describe("长期记忆召回门控", () => {
  it("does not recall or advertise tools when memory is disabled", async () => {
    const result = await recallForPromptWithStats("你还记得我的偏好吗？", {
      userId: "user-1",
      config: disabledConfig,
    });
    expect(result).toMatchObject({ eligible: false, selectedCount: 0, rerankReason: "memory_disabled" });
    expect(renderMemoryPrefetchHint(result)).toBe("");
  });
  it("skips generic questions and temporary tasks", () => {
    expect(shouldRecallLongTermMemory("解释一下 React Server Components")).toBe(false);
    expect(shouldRecallLongTermMemory("帮我把这段代码改成 TypeScript")).toBe(false);
    expect(shouldRecallLongTermMemory("今天天气怎么样")).toBe(false);
  });

  it("allows explicit memory, profile, preference, and continuity requests", () => {
    expect(shouldRecallLongTermMemory("你还记得我的编程偏好吗？")).toBe(true);
    expect(shouldRecallLongTermMemory("根据我的过敏情况推荐晚餐")).toBe(true);
    expect(shouldRecallLongTermMemory("我最喜欢的食物是啥")).toBe(true);
    expect(shouldRecallLongTermMemory("我最爱吃什么菜")).toBe(true);
    expect(shouldRecallLongTermMemory("我的口味偏好是什么")).toBe(true);
    expect(shouldRecallLongTermMemory("继续上次的项目规划")).toBe(true);
    expect(shouldRecallLongTermMemory("Based on my preferences, recommend a laptop")).toBe(true);
  });

  // 止血分支：「时间指代 + 疑问词」的句式，与上面 40 多个动词分支正交。
  // 这类问题此前完全不召回，模型只能凭空作答，是唯一「用户正在裸答」的场景。
  it("catches temporal reference questions that name no memory verb", () => {
    expect(shouldRecallLongTermMemory("我之前说的预算是多少")).toBe(true);
    expect(shouldRecallLongTermMemory("上次那个方案叫什么")).toBe(true);
    expect(shouldRecallLongTermMemory("以前我住哪")).toBe(true);
    expect(shouldRecallLongTermMemory("当初定的是不是三月")).toBe(true);
  });

  // 负例是这条正则的前置条件，不是补充测试。
  // 「之前 + 疑问词」在技术问答里极其常见（"之前那个报错是什么意思"），
  // 误召回会把无关的个人事实塞进 prompt —— 召回错的比不召回更糟，
  // 因为模型会把它当成用户已确认的前提去推理。
  it("does not fire on technical or public-information questions that merely say 之前", () => {
    expect(shouldRecallLongTermMemory("之前那个正则怎么写的")).toBe(false);
    expect(shouldRecallLongTermMemory("上次的报错是什么原因")).toBe(false);
    expect(shouldRecallLongTermMemory("以前这个函数的参数是什么")).toBe(false);
    expect(shouldRecallLongTermMemory("之前那条 SQL 哪里错了")).toBe(false);
    expect(shouldRecallLongTermMemory("之前的天气怎么样")).toBe(false);
    expect(shouldRecallLongTermMemory("原来的版本号是多少")).toBe(false);
  });

  // 只有「时间指代」没有疑问词，是陈述句，不该触发检索。
  it("requires both a temporal reference and an interrogative", () => {
    expect(shouldRecallLongTermMemory("之前我们讨论过这个")).toBe(false);
    expect(shouldRecallLongTermMemory("这个方案多少钱")).toBe(false);
  });
});
