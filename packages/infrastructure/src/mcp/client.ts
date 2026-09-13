import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  adaptMcpTool,
  type McpCallResult,
} from "@/lib/agent/tools/mcp-adapter";
import type { McpToolPolicy } from "@/lib/agent/tools/mcp-adapter";

export type McpServerConfig = {
  name?: string;
  id: string;
  url: string;
  tools: McpToolPolicy[];
};
import { createSafeProviderFetch } from "@/lib/llm/url-safety";

export async function connectMcpServer(
  config: McpServerConfig,
  input: { userId: string; signal: AbortSignal },
  token = "",
  options: { fetch?: typeof fetch } = {},
) {
  const setup = new AbortController();
  const setupTimer = setTimeout(() => setup.abort(), 10_000);
  const client = new Client({ name: "personal-assistant", version: "0.1.0" });
  const fetchEndpoint =
    options.fetch ?? createSafeProviderFetch(config.url, 120_000);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    // Forbid redirects so an endpoint cannot redirect credentials to another host.
    fetch: (url, init) =>
      fetchEndpoint(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          input.signal,
          setup.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      input.signal.removeEventListener("abort", onAbort);
      // DELETE is best effort and bounded; close() alone only closes the local transport.
      const cleanupTimer = setTimeout(() => setup.abort(), 1_000);
      try {
        if (
          transport.sessionId &&
          !input.signal.aborted &&
          !setup.signal.aborted
        )
          await transport.terminateSession();
      } catch {
        /* The server may not support session termination. */
      } finally {
        clearTimeout(cleanupTimer);
        await client.close();
        await transport.close();
      }
    })());
  const onAbort = () => {
    void close().catch(() => {});
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    input.signal.throwIfAborted();
    await client.connect(transport, { signal: input.signal, timeout: 10_000 });
    const discovered = new Map<
      string,
      Awaited<ReturnType<Client["listTools"]>>["tools"][number]
    >();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        signal: input.signal,
        timeout: 10_000,
      });
      for (const tool of result.tools) {
        if (discovered.has(tool.name)) throw new Error("Duplicate MCP tool");
        discovered.set(tool.name, tool);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || page === 19)
        throw new Error("MCP discovery pagination limit");
      cursors.add(cursor);
    }
    const tools = config.tools.map((policy) => {
      const tool = discovered.get(policy.name);
      if (!tool || JSON.stringify(tool.inputSchema).length > 32_000)
        throw new Error("MCP tool unavailable or schema too large");
      return adaptMcpTool({
        serverId: config.id,
        serverName: config.name,
        userId: input.userId,
        tool,
        policy,
        call: async (args, signal) => {
          if (closing || input.signal.aborted)
            throw new Error("MCP session closed");
          return (await client.callTool(
            { name: policy.name, arguments: args },
            undefined,
            {
              signal: signal
                ? AbortSignal.any([signal, input.signal])
                : input.signal,
              timeout: policy.timeoutSeconds * 1000,
            },
          )) as McpCallResult;
        },
      });
    });
    input.signal.throwIfAborted();
    return { tools, close, discoveredTools: Array.from(discovered.values()) };
  } catch {
    await close().catch(() => {});
    throw new Error("MCP server initialization failed");
  } finally {
    clearTimeout(setupTimer);
  }
}
