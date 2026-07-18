// 内置工具
import { ToolRegistry } from "./registry";
import { getCurrentTimeTool } from "./current-time";
import { calculatorTool } from "./calculator";
import { createSearchNotesTool } from "./search-notes";
import { createTodoTool } from "./create-todo";
import { dailyLeetCodeTool } from "./daily-leetcode";
import { leetCodeWrongBookTool } from "./leetcode-wrong-book";
import { createScheduledJobTool } from "./scheduled-jobs";
import { createWebSearchTool } from "./web-search";
import { createWebFetchTool } from "./web-fetch";
import { readToolArtifactTool } from "./read-tool-artifact";
import { askUserTool } from "./ask-user";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

// 创建一个注册表，并把所有内置工具注册进去。
export function createBuiltinToolRegistry(options: {
  knowledgeProfile?: string;
  retrievalPlan?: RetrievalPlan;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(getCurrentTimeTool);
  registry.register(calculatorTool);
  registry.register(createSearchNotesTool({
    knowledgeProfile: options.knowledgeProfile,
    retrievalPlan: options.retrievalPlan,
  }));
  registry.register(createTodoTool);
  registry.register(dailyLeetCodeTool);
  registry.register(leetCodeWrongBookTool);
  registry.register(createScheduledJobTool);
  registry.register(createWebSearchTool({ retrievalPlan: options.retrievalPlan }));
  registry.register(createWebFetchTool({ retrievalPlan: options.retrievalPlan }));
  registry.register(readToolArtifactTool);
  registry.register(askUserTool);

  return registry;
}
