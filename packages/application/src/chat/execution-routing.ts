import { selectExecutionStrategy, type ExecutionStrategy } from "@/lib/agent/runtime/execution-strategy";
import { createPlanProposal, type ExecutionPlan, type PlanAndExecuteInput } from "@/lib/agent/runtime/plan-execution";
import { defaultChatModel } from "@/lib/agent/models";
import { ToolRegistry } from "@/lib/agent/tools/registry";

export async function prepareExecutionRoute(
  input: PlanAndExecuteInput & { approvedPlan?: ExecutionPlan; signal?: AbortSignal },
  dependencies = { select: selectExecutionStrategy, propose: createPlanProposal },
) {
  input.signal?.throwIfAborted();
  if (input.approvedPlan) {
    const strategy: ExecutionStrategy = {
      executionMode: "plan", requiresPlanReview: false,
      reason: "继续用户已确认的计划；具体操作仍需通过工具授权。",
      subgoals: input.approvedPlan.steps.map((step) => step.goal), source: "approved_plan",
    };
    return { strategy, plan: input.approvedPlan, planGenerationFailed: false, tools: input.tools, toolRegistry: input.toolRegistry };
  }
  const strategy = await dependencies.select({
    ...input, model: input.model ?? defaultChatModel,
  });
  input.signal?.throwIfAborted();
  if (strategy.executionMode === "direct") {
    return {
      strategy, plan: null, planGenerationFailed: false,
      tools: strategy.source === "fallback" ? [] : input.tools,
      toolRegistry: strategy.source === "fallback" ? new ToolRegistry() : input.toolRegistry,
    };
  }
  const plan = await dependencies.propose({ ...input, subgoals: strategy.subgoals }).catch(() => null);
  input.signal?.throwIfAborted();
  return { strategy, plan, planGenerationFailed: !plan, tools: input.tools, toolRegistry: input.toolRegistry };
}
