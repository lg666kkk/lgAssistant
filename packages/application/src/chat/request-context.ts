import { buildPromptPipe, type PromptPipeInput } from "@/lib/agent/prompt/pipe";
import { filterToolsForRetrievalRoute } from "@/lib/agent/rag/retrieval-router";
import type { RetrievalPlan } from "@/lib/agent/rag/types";
import type { ToolRegistry } from "@/lib/agent/tools/registry";
import { renderToolOrchestrationPolicy } from "@/lib/agent/tools/orchestration";
import { filterToolsForUserIntent } from "@/lib/agent/tools/tool-intent";

export function selectChatTools(input: {
  registry: ToolRegistry;
  retrievalPlan: RetrievalPlan;
  webSearchEnabled: boolean;
  memoryEnabled: boolean;
  supportsTools: boolean;
  query: string;
}) {
  const definitions = filterToolsForRetrievalRoute(input.registry.list(), input.retrievalPlan.route, {
    webEnabled: input.webSearchEnabled,
  }).filter((tool) => input.memoryEnabled || !["recall_memory", "search_memory_history"].includes(tool.name));
  const tools = input.supportsTools
    ? filterToolsForUserIntent(input.registry.listForModel(definitions), input.query)
    : [];
  return { definitions, tools };
}

export function buildChatPrompt(input: PromptPipeInput & {
  toolDefinitions: ReturnType<ToolRegistry["list"]>;
  retrievalPlan: RetrievalPlan;
}) {
  return buildPromptPipe({
    ...input,
    toolOrchestration: renderToolOrchestrationPolicy(input.toolDefinitions, input.retrievalPlan),
    maxTokens: 4200,
  });
}
