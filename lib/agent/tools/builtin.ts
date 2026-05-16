// 内置工具
import { ToolRegistry } from "./registry";
import { getCurrentTimeTool } from "./current-time";
import { calculatorTool } from "./calculator";

// 创建一个注册表，并把所有内置工具注册进去。
export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(getCurrentTimeTool);
  registry.register(calculatorTool);

  return registry;
}