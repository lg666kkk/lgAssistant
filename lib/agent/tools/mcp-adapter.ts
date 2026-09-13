import { createHash } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { defaultToolRuntimePolicy, type ToolDefinition, type ToolInputSchema, type ToolResult } from "./types";

export type McpToolPolicy = {
  name: string;
  riskLevel: "safe" | "confirm";
  sideEffect: "read" | "write" | "external";
  timeoutSeconds: number;
};

export type RemoteMcpTool = {
  name: string;
  description?: string;
  inputSchema: ToolInputSchema;
};

export type McpCallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
};

export function mcpToolName(serverId: string, remoteName: string) {
  const suffix = createHash("sha256").update(JSON.stringify([serverId, remoteName])).digest("hex").slice(0, 16);
  const label = `${serverId}_${remoteName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 42);
  return `mcp_${label}_${suffix}`; // <= 63 characters; stable even for punctuation/long names.
}

export function normalizeMcpResult(result: McpCallResult, serverId: string, remoteName: string): ToolResult {
  const maxChars = 16_000;
  const unsupported = new Set<string>();
  const parts = (result.content ?? []).map((block) => {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    unsupported.add(block.type);
    return `[MCP 返回 ${block.type} 内容，本版本不支持展示]`;
  });
  const serialized = result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent);
  if (serialized) parts.push(serialized);
  const fullContent = parts.join("\n") || (result.isError ? "MCP 工具执行失败" : "MCP 工具执行完成，无文本结果");
  const truncated = fullContent.length > maxChars;
  return {
    ok: result.isError !== true,
    content: truncated ? `${fullContent.slice(0, maxChars)}\n[MCP 结果已截断]` : fullContent,
    // Do not leave an unbounded copy of truncated output in model messages or traces.
    data: serialized && serialized.length <= maxChars ? result.structuredContent : undefined,
    error: result.isError ? "MCP tool reported an error" : undefined,
    metadata: { source: "mcp", serverId, remoteToolName: remoteName, truncated, unsupportedContentTypes: Array.from(unsupported) },
  };
}

export function adaptMcpTool(input: {
  serverId: string;
  serverName?: string;
  userId: string;
  tool: RemoteMcpTool;
  policy: McpToolPolicy;
  call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpCallResult>;
}): ToolDefinition {
  // A separate compiler avoids remote $id collisions between servers/sessions.
  const ajv = new Ajv({ strict: false, strictSchema: true, validateFormats: true });
  addFormats(ajv);
  const validate = ajv.compile(input.tool.inputSchema);
  if ("$async" in validate && validate.$async) throw new Error("Asynchronous MCP input schemas are unsupported");
  const writes = input.policy.sideEffect !== "read";
  const riskLevel = writes ? "confirm" : input.policy.riskLevel;
  return {
    name: mcpToolName(input.serverId, input.tool.name),
    display: { source: "mcp", serverName: input.serverName || "MCP 服务", remoteToolName: input.tool.name, description: (input.tool.description ?? "").slice(0, 2000) },
    description: `[MCP: ${input.serverId}/${input.tool.name}] ${(input.tool.description ?? "").slice(0, 2_000)}`,
    input_schema: input.tool.inputSchema,
    capabilities: [`mcp.${input.serverId}.${input.tool.name}`],
    // Generic external reads are not automatically trusted RAG evidence.
    outputPolicy: { grounding: writes ? "action_receipt" : "none", citationRequired: false },
    riskLevel,
    runtime: {
      ...defaultToolRuntimePolicy,
      requiresAuth: true,
      sandboxed: false,
      sideEffect: input.policy.sideEffect,
      requiresConfirmation: riskLevel === "confirm",
      timeoutSeconds: input.policy.timeoutSeconds,
      rateLimit: 30,
      concurrencyGroup: `mcp.${input.serverId}`,
      maxConcurrency: 2,
    },
    async execute(args, context) {
      const metadata = { source: "mcp", serverId: input.serverId, remoteToolName: input.tool.name };
      if (context?.userId !== input.userId) {
        return { ok: false, content: "无权调用此 MCP 工具", error: "MCP authorization denied", metadata };
      }
      if (!validate(args)) {
        return { ok: false, content: "MCP 工具参数不符合 JSON Schema", error: "Invalid MCP tool arguments", metadata };
      }
      try {
        context?.signal?.throwIfAborted();
        return normalizeMcpResult(await input.call(args as Record<string, unknown>, context?.signal), input.serverId, input.tool.name);
      } catch {
        // Transport errors may contain URLs, headers, and credentials. No automatic retry.
        return { ok: false, content: writes ? "MCP 调用中断，远端操作状态未知，请先核实再重试" : "MCP 服务调用失败或已取消", error: "MCP call failed", metadata };
      }
    },
  };
}
