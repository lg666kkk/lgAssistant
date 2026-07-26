import type { RetrievalPlan } from "@/lib/agent/rag/types";
import type { ToolDefinition, ToolOrchestrationCondition } from "./types";

function isConditionActive(
  condition: ToolOrchestrationCondition,
  retrievalPlan?: RetrievalPlan,
) {
  if (condition === "public_freshness_required") {
    // “显式要求查官网”只代表来源约束，不一定依赖当前日期。只有路由器同时
    // 判定 freshnessRequired，且本轮确实允许 Web 检索时，才激活时间前置条件。
    return retrievalPlan?.freshnessRequired === true
      && (retrievalPlan.route === "web" || retrievalPlan.route === "both");
  }
  return false;
}

export function missingToolPrerequisites(
  tool: ToolDefinition,
  satisfiedCapabilities: ReadonlySet<string>,
  retrievalPlan?: RetrievalPlan,
) {
  const policy = tool.orchestration;
  if (!policy || !isConditionActive(policy.invokeWhen, retrievalPlan)) return [];
  return policy.prerequisites.filter((capability) => !satisfiedCapabilities.has(capability));
}

/**
 * 把同一份结构化编排策略投影成模型可读提示。
 * Runtime 仍会独立强制这些依赖；这里的文本只用于让模型第一次就选对调用顺序，
 * 不能作为安全边界，也不能替代 missingToolPrerequisites 的执行期检查。
 */
export function renderToolOrchestrationPolicy(
  tools: ToolDefinition[],
  retrievalPlan?: RetrievalPlan,
) {
  const lines = ["用户已开启联网能力；根据可用工具的能力元数据选择工具。"];
  for (const tool of tools) {
    const policy = tool.orchestration;
    if (!policy || !isConditionActive(policy.invokeWhen, retrievalPlan)) continue;
    const providers = policy.prerequisites.map((capability) => {
      const names = tools
        .filter((candidate) => candidate.capabilities.includes(capability))
        .map((candidate) => candidate.name);
      return `${capability}${names.length > 0 ? ` (${names.join(", ")})` : ""}`;
    });
    lines.push(
      `条件 ${policy.invokeWhen} 已生效：调用 ${tool.name} 前必须先完成 ${providers.join("、")}，并等待其结果。`,
    );
  }
  return lines.join("\n");
}

/**
 * Plan step 原本只保存模型生成的工具名。若其中某个工具有激活的 capability
 * 依赖，这里把所有可提供该 capability 的工具加入该 step 的可见集合。
 *
 * 使用闭包迭代而不是只扩一层，是为了支持 A -> B -> C 的传递依赖；Set 同时
 * 保证存在环或多个 provider 时不会无限追加。这里只扩大“可见工具”，真正是否
 * 已满足依赖仍由 Runtime 根据成功执行记录判断。
 */
export function expandToolNamesWithPrerequisites(
  toolNames: Iterable<string>,
  tools: ToolDefinition[],
  retrievalPlan?: RetrievalPlan,
) {
  const expanded = new Set(toolNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Array.from(expanded)) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) continue;
      const requiredCapabilities = missingToolPrerequisites(
        tool,
        new Set<string>(),
        retrievalPlan,
      );
      for (const candidate of tools) {
        if (!candidate.capabilities.some((capability) =>
          requiredCapabilities.includes(capability))) continue;
        if (!expanded.has(candidate.name)) {
          expanded.add(candidate.name);
          changed = true;
        }
      }
    }
  }
  return expanded;
}
