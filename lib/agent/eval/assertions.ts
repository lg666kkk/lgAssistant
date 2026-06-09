import { expect } from "vitest";
import type { EvalCase } from "./cases";
import type { EvalRunResult } from "./runner";

export function assertCase(res: EvalRunResult, c: EvalCase) {
  if (c.expect.shouldComplete !== undefined) {
    expect(res.completed).toBe(c.expect.shouldComplete);
  }

  if (c.expect.shouldCallTool) {
    expect(hasToolCall(res, c.expect.shouldCallTool)).toBe(true);
  }

  if (c.expect.maxModelCalls !== undefined) {
    expect(res.metrics.modelCallCount).toBeLessThanOrEqual(
      c.expect.maxModelCalls,
    );
  }

  if (c.expect.mustNotError) {
    const hasError = res.trace.steps.some(
      (s) => s.type === "tool" && !s.ok,
    );
    expect(hasError).toBe(false);
  }
}

export function hasToolCall(res: EvalRunResult, toolName: string) {
  return res.trace.steps.some(
    (s) => s.type === "tool" && s.name === toolName,
  );
}
