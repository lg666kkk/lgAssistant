import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { runAgentLoop } from "./index";

describe("Agent request cancellation", () => {
  it("passes the request signal to the model and stops an in-flight call", async () => {
    const controller = new AbortController();
    const callModel = vi.fn(async (...args: unknown[]) => {
      const signal = args[8] as AbortSignal;
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("request cancelled"));
      signal.throwIfAborted();
      return {} as never;
    });
    await expect(runAgentLoop(
      [{ role: "user", content: "hello" }], [], new ToolRegistry(), 2, [], () => true,
      "cancel-test", undefined, { callModel }, undefined, () => controller.signal.aborted,
      undefined, undefined, undefined, undefined, [], undefined, [], undefined, new Map(), controller.signal,
    )).rejects.toThrow("request cancelled");
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("does not mislabel an explicit stop as completion", async () => {
    const callModel = vi.fn();
    const result = await runAgentLoop([], [], new ToolRegistry(), 2, [], () => true,
      "stopped", undefined, { callModel }, undefined, () => true);
    expect(result.trace).toMatchObject({ completed: false, stopReason: "aborted" });
    expect(callModel).not.toHaveBeenCalled();
  });
});
