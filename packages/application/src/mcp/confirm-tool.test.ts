import { describe, expect, it, vi } from "vitest";
import { confirmTool } from "./confirm-tool";
import { adaptMcpTool } from "@/lib/agent/tools/mcp-adapter";
import type { ChatApplicationDependencies } from "../chat/ports";

describe("confirmed MCP execution observability", () => {
  it.each([true, false])("records a confirmed remote call with ok=%s in both trace sinks and closes the connection", async (ok) => {
    const call = vi.fn(async () => ({ isError: !ok, content: [{ type: "text", text: ok ? "created" : "denied" }] }));
    const tool = adaptMcpTool({ serverId: "service-1", serverName: "营销服务", userId: "alice", tool: { name: "campaign-create", inputSchema: { type: "object" } }, policy: { name: "campaign-create", riskLevel: "confirm", sideEffect: "write", timeoutSeconds: 10 }, call });
    const close = vi.fn(async () => {});
    const save = vi.fn(async () => {});
    const end = vi.fn();
    const remote = { update: vi.fn(), setTraceIO: vi.fn(), startObservation: vi.fn(() => ({ update: vi.fn(), end })) };
    const dependencies = {
      externalTools: { open: vi.fn(async () => ({ tools: [tool], close })) },
      traces: { save },
      telemetry: { withTrace: vi.fn(async (_input: unknown, callback: (scope: { trace: typeof remote }) => Promise<unknown>) => callback({ trace: remote })) },
    } as unknown as ChatApplicationDependencies;
    const result = await confirmTool({ userId: "alice", sessionId: "session-1", requestId: "confirmation-1", signal: new AbortController().signal, toolCall: { id: "call-1", name: tool.name, input: {} }, dependencies });
    expect(result.ok).toBe(ok);
    expect(call).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ requestId: "confirmation-1", sessionId: "session-1", steps: [expect.objectContaining({ ok, toolCallId: "call-1", metadata: expect.objectContaining({ serverName: "营销服务", remoteToolName: "campaign-create", confirmed: true }) })] }), "alice");
    expect(remote.startObservation).toHaveBeenCalledWith("mcp:营销服务:campaign-create", expect.objectContaining({ output: expect.objectContaining({ ok }) }), { asType: "tool" });
    expect(end).toHaveBeenCalledTimes(1);
  });
});
