import { describe, it, expect } from "vitest";
import { runAgentLoop, type ToolSourceType } from "@/lib/agent/runtime";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { evalCases } from "./cases";

const RUN_LIVE = process.env.EVAL_LIVE === "1";

// 跑一条 case，返回 trace + metrics，供断言
async function runCase(
  messages: { role: "user" | "assistant"; content: string }[],
  deps?: { callModel: any },
) {
  const registry = createBuiltinToolRegistry();
  const sources: ToolSourceType[] = [];
  return runAgentLoop(
    messages,
    registry.listForModel(),
    registry,
    8,
    sources,
    () => true,            // enqueueText：eval 不关心流式输出，直接吞掉
    "eval",                // requestId
    undefined,             // sessionId
    deps,                  // 注入点：live 轨传 undefined 用真实 callModel
  );
}

// 把一组断言抽出来，两条轨道复用
function assertCase(res: Awaited<ReturnType<typeof runCase>>, c: (typeof evalCases)[number]) {
  if (c.expect.shouldComplete !== undefined) {
    expect(res.completed).toBe(c.expect.shouldComplete);
  }
  if (c.expect.shouldCallTool) {
    const called = res.trace.steps.some(
      (s) => s.type === "tool" && s.name === c.expect.shouldCallTool,
    );
    expect(called).toBe(true);
  }
  if (c.expect.maxModelCalls !== undefined) {
    expect(res.metrics.modelCallCount).toBeLessThanOrEqual(c.expect.maxModelCalls);
  }
  if (c.expect.mustNotError) {
    const hasError = res.trace.steps.some((s) => s.type === "tool" && !s.ok);
    expect(hasError).toBe(false);
  }
}

// ---- mock 轨：默认跑，验证编排逻辑，不调真模型 ----
describe("eval (mock)", () => {
  it("calc-tool 编排：模型要求调 calculator → 回传结果 → 结束", async () => {
    let turn = 0;
    // 假模型：第一轮要求调 calculator，第二轮给最终文本
    const fakeCallModel = async () => {
      turn++;
      if (turn === 1) {
        return {
          content: [
            { type: "tool_use", id: "t1", name: "calculator", input: { expression: "123*456" } },
          ],
        };
      }
      return { content: [{ type: "text", text: "结果是 56088" }] };
    };
    const res = await runCase(
      [{ role: "user", content: "算 123*456" }],
      { callModel: fakeCallModel as any },
    );
    expect(res.completed).toBe(true);
    expect(res.trace.steps.some((s) => s.type === "tool" && s.name === "calculator")).toBe(true);
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
