// 内置工具
import { ToolRegistry } from "./registry";
import { getCurrentTimeTool } from "./current-time";
import { calculatorTool } from "./calculator";
import { createSearchNotesTool } from "./search-notes";
import { createTodoTool } from "./create-todo";
import { dailyLeetCodeTool } from "./daily-leetcode";
import { leetCodeWrongBookTool } from "./leetcode-wrong-book";
import { createScheduledJobTool } from "./scheduled-jobs";
import { webSearchTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { readToolArtifactTool } from "./read-tool-artifact";

// 创建一个注册表，并把所有内置工具注册进去。
export function createBuiltinToolRegistry(options: {
  knowledgeProfile?: string;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(getCurrentTimeTool);
  registry.register(calculatorTool);
  registry.register(createSearchNotesTool({
    knowledgeProfile: options.knowledgeProfile,
  }));
  registry.register(createTodoTool);
  registry.register(dailyLeetCodeTool);
  registry.register(leetCodeWrongBookTool);
  registry.register(createScheduledJobTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(readToolArtifactTool);

  return registry;
}
