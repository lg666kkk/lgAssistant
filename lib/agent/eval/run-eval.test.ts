import { describe, it, expect } from "vitest";
import { evalCases } from "./datasets/agent";
import { assertCase, hasToolCall } from "./assertions";
import { createCalculatorToolThenAnswerModel } from "./mock-models";
import { runCase } from "./runner";

const RUN_LIVE = process.env.EVAL_LIVE === "1";

// ---- mock 轨：默认跑，验证编排逻辑，不调真模型 ----
describe("eval (mock)", () => {
  it("calc-tool 编排：模型要求调 calculator → 回传结果 → 结束", async () => {
    const res = await runCase(
      [{ role: "user", content: "算 123*456" }],
      { callModel: createCalculatorToolThenAnswerModel() as any },
    );

    expect(res.completed).toBe(true);
    expect(hasToolCall(res, "calculator")).toBe(true);
    expect(res.metrics.modelCallCount).toBe(2);
  });
});

// ---- live 轨：EVAL_LIVE=1 才跑，真调模型，验证选工具能力 ----
describe.skipIf(!RUN_LIVE)("eval (live)", () => {
  for (const c of evalCases) {
    it(c.description, async () => {
      const res = await runCase(c.messages);
      assertCase(res, c);
    });
  }
});
