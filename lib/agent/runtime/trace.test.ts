import { describe, it, expect } from "vitest";
import { createTrace } from "./trace";

describe("trace 冒烟测试", () => {
  it("createTrace 初始化一棵空树", () => {
    const t = createTrace("req-1");
    expect(t.requestId).toBe("req-1");
    expect(t.steps).toEqual([]);
    expect(t.completed).toBe(false);
  });
});
