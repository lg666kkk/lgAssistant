import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { prepareExecutionRoute } from "./execution-routing";
import type { ExecutionStrategy } from "@/lib/agent/runtime/execution-strategy";
import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { defaultToolRuntimePolicy } from "@/lib/agent/tools/types";

const tools = ["list_skills", "view_skill", "run_skill", "create_todo"].map((name) => ({ name, description: name, input_schema: { type: "object" as const } }));
const input = { messages: [{ role: "user" as const, content: "使用技能完成任务" }], tools, toolRegistry: new ToolRegistry(), requestId: "route-test", maxToolIterations: 4, allToolSources: [] };
const plan = { id: "plan-1", objective: "完成任务", steps: [
  { id: "step-1", goal: "检查资料", allowedTools: ["list_skills", "view_skill"], successCriteria: ["加载技能"] },
  { id: "step-2", goal: "执行任务", allowedTools: ["run_skill"], successCriteria: ["取得结果"] },
] };

function strategy(overrides: Partial<ExecutionStrategy> = {}): ExecutionStrategy {
  return { executionMode: "direct", requiresPlanReview: false, reason: "单一目标", subgoals: ["完成任务"], source: "model", ...overrides };
}

describe("execution route preparation", () => {
  it("keeps all scoped skills available in direct mode without generating a plan", async () => {
    const dependencies = { select: vi.fn().mockResolvedValue(strategy()), propose: vi.fn() };
    const route = await prepareExecutionRoute(input, dependencies);
    expect(route.plan).toBeNull();
    expect(route.tools).toBe(tools);
    expect(dependencies.propose).not.toHaveBeenCalled();
  });

  it.each([false, true])("separates planned execution from plan review=%s", async (requiresPlanReview) => {
    const decision = strategy({ executionMode: "plan", requiresPlanReview, subgoals: ["检查资料", "执行任务"] });
    const dependencies = { select: vi.fn().mockResolvedValue(decision), propose: vi.fn().mockResolvedValue(plan) };
    const route = await prepareExecutionRoute(input, dependencies);
    expect(route.plan).toBe(plan);
    expect(route.strategy.requiresPlanReview).toBe(requiresPlanReview);
    expect(route.tools).toBe(tools);
    expect(dependencies.propose).toHaveBeenCalledWith(expect.objectContaining({ tools, subgoals: decision.subgoals }));
    expect(route).not.toHaveProperty("approved");
  });

  it("resumes approved plans without reclassifying or authorizing individual tools", async () => {
    const dependencies = { select: vi.fn(), propose: vi.fn() };
    const route = await prepareExecutionRoute({ ...input, approvedPlan: plan }, dependencies);
    expect(route.plan).toBe(plan);
    expect(route.strategy).toMatchObject({ source: "approved_plan", requiresPlanReview: false });
    expect(dependencies.select).not.toHaveBeenCalled();
    expect(dependencies.propose).not.toHaveBeenCalled();
    expect(route).not.toHaveProperty("approved");
  });

  it("suppresses all tool calls when strategy classification fails", async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register({
      name: "view_skill", description: "读取技能", capabilities: ["skill.view"],
      input_schema: { type: "object" }, outputPolicy: { grounding: "none", citationRequired: false },
      riskLevel: "safe", runtime: defaultToolRuntimePolicy, execute,
    });
    const dependencies = { select: vi.fn().mockResolvedValue(strategy({ source: "fallback", fallbackReason: "provider_error" })), propose: vi.fn() };
    const route = await prepareExecutionRoute({ ...input, toolRegistry: registry }, dependencies);
    expect(route.tools).toEqual([]);
    expect(route.toolRegistry.list()).toEqual([]);
    const result = await executeToolCall(route.toolRegistry, { name: "view_skill", input: {} });
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(dependencies.propose).not.toHaveBeenCalled();
  });

  it.each([null, new Error("failed")])("does not silently execute a template when planning fails: %s", async (result) => {
    const propose = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
    const route = await prepareExecutionRoute(input, { select: vi.fn().mockResolvedValue(strategy({ executionMode: "plan" })), propose });
    expect(route).toMatchObject({ plan: null, planGenerationFailed: true });
  });
});
