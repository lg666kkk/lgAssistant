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
import type { ToolCall, ToolExecutionResult, ExecuteToolCallOptions } from "./types";
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
  options: ExecuteToolCallOptions = {},
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
  if (tool.riskLevel === "confirm" && !options.approved) {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 需要用户确认后才能执行`,
      error: `Tool requires approval: ${tool.name}`,
      metadata: {
        status: "pending_confirmation",
        riskLevel: tool.riskLevel,
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        },
      },
    };
  }

  if (tool.riskLevel === "dangerous") {
    return {
      ok: false,
      toolName: tool.name,
      toolCallId: toolCall.id,
      content: `工具 ${tool.name} 风险过高，已拒绝执行`,
      error: `Dangerous tool blocked: ${tool.name}`,
      metadata: {
        status: "blocked",
        riskLevel: tool.riskLevel,
      },
    };
  }
  const result = await tool.execute(toolCall.input);
  return {
    ...result,
    toolName: tool.name,
    toolCallId: toolCall.id,
  };
}
