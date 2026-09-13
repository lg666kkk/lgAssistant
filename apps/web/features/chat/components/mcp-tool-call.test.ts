import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMcpCallPresentation, McpToolCallDetails } from "./mcp-tool-call";

describe("MCP call presentation", () => {
  it("shows a readable service and complete remote name instead of the hashed ID", () => {
    expect(getMcpCallPresentation({ name: "mcp_u_hash", metadata: { source: "mcp", serverName: "营销服务", remoteToolName: "campaign-list-all" } })?.label).toBe("营销服务 · campaign-list-all");
    expect(getMcpCallPresentation({ name: "mcp_old", metadata: { remoteToolName: "campaign-list-all" } })?.label).toBe("MCP 服务 · campaign-list-all");
    expect(getMcpCallPresentation({ name: "calculator" })).toBeNull();
  });
  it("renders pending arguments open without presenting a result as executed", () => {
    const html = renderToStaticMarkup(createElement(McpToolCallDetails, { tool: { id: "1", name: "mcp_test", ok: false, content: "pending", input: { campaign: "summer" }, metadata: { status: "pending_confirmation" } } }));
    expect(html).toContain('open=""');
    expect(html).toContain("summer");
    expect(html).toContain("等待确认，尚未执行");
  });
  it("renders result and duration and escapes remote HTML", () => {
    const html = renderToStaticMarkup(createElement(McpToolCallDetails, { tool: { id: "1", name: "mcp_test", ok: true, content: "<script>remote</script>", metadata: { durationMs: 42 } } }));
    expect(html).toContain("42 ms");
    expect(html).toContain("返回结果");
    expect(html).not.toContain("<script>");
  });
});
