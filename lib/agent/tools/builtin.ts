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
import { listSkillsTool, runSkillTool, viewSkillTool } from "./sandbox-skills";
import {
  createRecallMemoryTool,
  createSearchMemoryHistoryTool,
} from "./memory-recall";
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
  registry.register(listSkillsTool);
  registry.register(viewSkillTool);
  registry.register(runSkillTool);
  registry.register(askUserTool);
  // 两个工具必须同时注册。只有 recall_memory 时，模型问「以前的预算」会拿当前值
  // 当历史答；只有 search_memory_history 时，问当前值会翻出一堆失效版本。
  // 它们的 description 互相指路，缺一个另一个的边界说明就指向不存在的工具。
  registry.register(createRecallMemoryTool());
  registry.register(createSearchMemoryHistoryTool());

  return registry;
}
