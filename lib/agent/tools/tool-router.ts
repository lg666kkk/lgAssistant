/**
 * 负责把这类请求 变成真正的执行结果
 *
 * {
 *  "name": "get_current_time",
 *  "input": {
 *    "timezone": "Asia/Shanghai",
 *    "locale": "zh-CN"
 *  }
 * }
 *
 * 变成真正的执行结果
 * {
 *      ok: true,
 *      toolName: "get_current_time",
 *      content: "当前时间：...",
 * }
 */
import type { ToolCall, ToolExecutionResult } from "./types";
import { ToolRegistry } from "./registry";

/**
 *
 * 表示异步返回工具执行结果。
 * 为什么异步？
 * 因为工具可能会：
 *    读文件、查数据库、调 API、跑命令
 * 所以 Router 统一设计成异步。
 */
export async function executeToolCall(
  registry: ToolRegistry,
  toolCall: ToolCall,
): Promise<ToolExecutionResult> {
  const tool = registry.get(toolCall.name);
  if (!tool) {
    return {
      ok: false,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      content: `工具不存在：${toolCall.name}`,
      error: `Unknown tool: ${toolCall.name}`,
    };
  }
  // TODO: 检查工具风险等级，如果需要用户确认，则返回需要确认的结果
  if (tool.riskLevel !== "safe") {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 需要用户确认后才能执行`,
      error: `Tool requires approval: ${tool.name}`,
    };
  }
  const result = await tool.execute(toolCall.input);
  return {
    ...result,
    toolName: tool.name,
    toolCallId: toolCall.id,
  };
}
