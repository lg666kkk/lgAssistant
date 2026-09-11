import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "./registry";
import { executeToolCall } from "./tool-router";
import { defaultToolRuntimePolicy, type ToolDefinition } from "./types";

function registryFor(execute: ToolDefinition["execute"]) {
  const registry = new ToolRegistry();
  registry.register({
    name: "slow", description: "slow", capabilities: [],
    input_schema: { type: "object" }, riskLevel: "safe",
    outputPolicy: { grounding: "none", citationRequired: false },
    runtime: { ...defaultToolRuntimePolicy, timeoutSeconds: 1 }, execute,
  });
  return registry;
}

afterEach(() => vi.useRealTimers());

describe("tool cancellation", () => {
  it("aborts a cooperative tool on timeout", async () => {
    vi.useFakeTimers();
    let toolSignal: AbortSignal | undefined;
    const registry = registryFor(async (_input, context) => {
      toolSignal = context?.signal;
      return new Promise(() => {});
    });
    const pending = executeToolCall(registry, { name: "slow", input: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ ok: false, metadata: { timedOut: true } });
    expect(toolSignal?.aborted).toBe(true);
  });

  it("does not start a tool after cancellation", async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await executeToolCall(registryFor(execute), { name: "slow", input: {} }, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards cancellation while a tool is running", async () => {
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const registry = registryFor(async (_input, context) => {
      toolSignal = context?.signal;
      return new Promise(() => {});
    });
    const pending = executeToolCall(registry, { name: "slow", input: {} }, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    expect(await pending).toMatchObject({ ok: false, metadata: { timedOut: false } });
    expect(toolSignal?.aborted).toBe(true);
  });

  it("normalizes non-Error tool failures", async () => {
    const registry = registryFor(async () => { throw "provider unavailable"; });
    expect(await executeToolCall(registry, { name: "slow", input: {} })).toMatchObject({
      ok: false, metadata: { error: "provider unavailable", timedOut: false },
    });
  });
});
