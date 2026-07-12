import { describe, expect, it } from "vitest";
import { shouldRecallLongTermMemory } from "./memory-flow";

describe("长期记忆召回门控", () => {
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
});
