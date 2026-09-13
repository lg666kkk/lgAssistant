import React from "react";
import type { ToolCallEventData } from "@repo/contracts";

export function getMcpCallPresentation(tool: Pick<ToolCallEventData, "name" | "metadata">) {
  const metadata = tool.metadata;
  if (metadata?.source !== "mcp" && !tool.name.startsWith("mcp_")) return null;
  const remoteName = typeof metadata?.remoteToolName === "string" ? metadata.remoteToolName : "工具调用";
  const serverName = typeof metadata?.serverName === "string" ? metadata.serverName : "MCP 服务";
  return { label: `${serverName} · ${remoteName}`, description: typeof metadata?.toolDescription === "string" ? metadata.toolDescription : "" };
}

export function McpToolCallDetails({ tool }: { tool: Omit<ToolCallEventData, "id"> & { id?: string } }) {
  const display = getMcpCallPresentation(tool);
  if (!display) return null;
  const pending = tool.metadata?.status === "pending_confirmation";
  const duration = tool.metadata?.durationMs;
  const input = tool.input ?? (tool.metadata?.toolCall as { input?: unknown } | undefined)?.input;
  return <details className="ml-3.5 mt-2 rounded-md border border-slate-700/50 bg-slate-950/30 px-3 py-2" open={pending || undefined}>
    <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
      查看参数与结果{typeof duration === "number" ? ` · ${duration} ms` : ""}
    </summary>
    <div className="mt-3 space-y-3">
      {display.description && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">{display.description}</p>}
      <div><p className="mb-1 text-slate-500">调用参数</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs">{input === undefined ? "此记录未保存参数" : JSON.stringify(input, null, 2)}</pre></div>
      <div><p className="mb-1 text-slate-500">{pending ? "执行状态" : "返回结果"}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{pending ? "等待确认，尚未执行" : tool.content || "无文本结果"}</pre></div>
      {tool.error && !pending && <p className="break-words text-rose-300">{tool.error}</p>}
      <p className="break-all text-[10px] text-slate-600">工具 ID：{tool.name}</p>
    </div>
  </details>;
}
