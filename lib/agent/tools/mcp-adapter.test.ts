import { describe, expect, it, vi } from "vitest";
import { adaptMcpTool, mcpToolName, normalizeMcpResult } from "./mcp-adapter";
import { ToolRegistry } from "./registry";
import { executeToolCall } from "./tool-router";

function fixture(writes = false) {
  const call = vi.fn(async () => ({ content: [{ type: "text", text: "found" }] }));
  const tool = adaptMcpTool({
    serverId: "test", serverName: "测试服务", userId: "alice",
    tool: { name: "search", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"], additionalProperties: false } },
    policy: { name: "search", sideEffect: writes ? "write" : "read", riskLevel: "safe", timeoutSeconds: 1 },
    call,
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  return { call, tool, registry };
}

describe("MCP tool governance", () => {
  it("forces writes through approval and only calls the remote after approval", async () => {
    const { tool, registry, call } = fixture(true);
    const request = { name: tool.name, input: { query: "hi" } };
    const pending = await executeToolCall(registry, request, { userId: "alice" });
    expect(pending.metadata?.status).toBe("pending_confirmation");
    expect(pending.metadata).toMatchObject({ serverName: "测试服务", remoteToolName: "search" });
    expect(call).not.toHaveBeenCalled();
    expect((await executeToolCall(registry, request, { userId: "alice", approved: true })).ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects another user and invalid nested schema constraints before network calls", async () => {
    const { tool, registry, call } = fixture();
    expect((await executeToolCall(registry, { name: tool.name, input: { query: "hi" } }, { userId: "bob" })).ok).toBe(false);
    for (const input of [{ query: "x" }, { query: 42 }, { query: "hi", extra: true }]) {
      expect((await executeToolCall(registry, { name: tool.name, input }, { userId: "alice" })).error).toBe("Invalid MCP tool arguments");
    }
    expect(call).not.toHaveBeenCalled();
    expect(registry.listForModel()[0].input_schema).toEqual(tool.input_schema);
  });

  it("propagates cancellation and does not expose raw transport errors", async () => {
    const { tool, call } = fixture();
    call.mockRejectedValueOnce(new Error("Authorization: secret"));
    const result = await tool.execute({ query: "hi" }, { userId: "alice" });
    expect(JSON.stringify(result)).not.toContain("secret");
    const controller = new AbortController();
    controller.abort();
    await tool.execute({ query: "hi" }, { userId: "alice", signal: controller.signal });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("bounds output, handles structured-only errors and explicitly marks unsupported blocks", () => {
    const result = normalizeMcpResult({ isError: true, structuredContent: { reason: "denied" }, content: [{ type: "image", data: "base64" }] }, "test", "search");
    expect(result.ok).toBe(false);
    expect(result.content).toContain("denied");
    expect(result.metadata?.unsupportedContentTypes).toEqual(["image"]);
    const huge = normalizeMcpResult({ structuredContent: { value: "x".repeat(50_000) } }, "test", "search");
    expect(huge.content.length).toBeLessThan(16_100);
    expect(huge.data).toBeUndefined();
    expect(huge.metadata?.truncated).toBe(true);
  });

  it("keeps provider-compatible stable names distinct after sanitization/truncation", () => {
    expect(mcpToolName("a", "b.c")).not.toBe(mcpToolName("a", "b_c"));
    expect(mcpToolName("a", "x".repeat(200))).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(mcpToolName("a", "b")).toBe(mcpToolName("a", "b"));
  });

  it("rejects asynchronous schemas instead of treating a validation Promise as success", () => {
    const inputSchema = { type: "object" as const, $async: true };
    expect(() => adaptMcpTool({
      serverId: "test", userId: "alice", tool: { name: "async", inputSchema },
      policy: { name: "async", riskLevel: "safe", sideEffect: "read", timeoutSeconds: 1 },
      call: vi.fn(),
    })).toThrow("Asynchronous MCP input schemas are unsupported");
  });
});
