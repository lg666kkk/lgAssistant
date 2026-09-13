import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { connectMcpServer, type McpServerConfig } from "./client";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function serve() {
  const requests: Array<{ method?: string; authorization?: string }> = [];
  const calls = vi.fn(async (_request: unknown) => ({
    content: [{ type: "text" as const, text: "pong" }],
    structuredContent: { value: "pong" },
  }));
  const mcp = new Server(
    { name: "test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async (request) =>
    request.params?.cursor === "page-2"
      ? {
          tools: [
            {
              name: "echo",
              description: "Echo a message",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
                additionalProperties: false,
              },
            },
          ],
        }
      : {
          tools: [{ name: "hidden", inputSchema: { type: "object" } }],
          nextCursor: "page-2",
        },
  );
  mcp.setRequestHandler(CallToolRequestSchema, calls);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  const http = createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
    });
    void transport.handleRequest(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  cleanups.push(async () => {
    await mcp.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const config: McpServerConfig = {
    id: "test",
    url: `http://127.0.0.1:${address.port}/mcp`,
    tools: [
      {
        name: "echo",
        riskLevel: "safe",
        sideEffect: "read",
        timeoutSeconds: 30,
      },
    ],
  };
  return { requests, calls, config };
}

describe("MCP Streamable HTTP integration", () => {
  it("initializes, discovers paginated allowlisted tools, invokes through the router and terminates the session", async () => {
    const fixture = await serve();
    const session = await connectMcpServer(
      fixture.config,
      { userId: "alice", signal: new AbortController().signal },
      "test-only-token",
      { fetch },
    );
    cleanups.push(() => session.close());
    expect(session.tools).toHaveLength(1);
    expect(session.tools[0].name).toContain("echo");
    const registry = new ToolRegistry();
    session.tools.forEach((tool) => registry.register(tool));
    const result = await executeToolCall(
      registry,
      { name: session.tools[0].name, input: { message: "ping" } },
      { userId: "alice" },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { value: "pong" },
      metadata: { serverId: "test", remoteToolName: "echo" },
    });
    expect(fixture.calls).toHaveBeenCalledTimes(1);
    expect(fixture.calls.mock.calls[0][0]).toMatchObject({
      params: { name: "echo", arguments: { message: "ping" } },
    });
    await session.close();
    await session.close();
    expect(
      fixture.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    expect(
      fixture.requests.every(
        (request) => request.authorization === "Bearer test-only-token",
      ),
    ).toBe(true);
    expect(
      (await session.tools[0].execute({ message: "ping" }, { userId: "alice" }))
        .ok,
    ).toBe(false);
    expect(fixture.calls).toHaveBeenCalledTimes(1);
  });

  it("closes partially initialized sessions when an allowlisted tool is absent", async () => {
    const fixture = await serve();
    const config = {
      ...fixture.config,
      tools: [{ ...fixture.config.tools[0], name: "missing" }],
    };
    await expect(
      connectMcpServer(
        config,
        { userId: "alice", signal: new AbortController().signal },
        "test-only-token",
        { fetch },
      ),
    ).rejects.toThrow("initialization failed");
    expect(
      fixture.requests.some((request) => request.method === "DELETE"),
    ).toBe(true);
  });
});
