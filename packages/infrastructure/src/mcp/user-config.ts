import Ajv from "ajv";
import type {
  McpServerDraft,
  McpServerView,
  McpManagedTool,
  McpDiscoveryResult,
} from "@repo/contracts";
import { getSupabase } from "@/lib/platform/supabase";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import type { ExternalToolsPort } from "@repo/application/mcp/ports";
import { connectMcpServer, type McpServerConfig } from "./client";

type Row = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  token_ciphertext: string;
  tools: McpManagedTool[];
  updated_at: string;
};
const columns = "id,name,url,enabled,token_ciphertext,tools,updated_at";
const validate = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: ["name", "url", "enabled", "tools"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    enabled: { type: "boolean" },
    token: { type: "string", maxLength: 4000 },
    clearToken: { type: "boolean" },
    tools: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "enabled", "approval"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 128 },
          description: { type: "string", maxLength: 2000 },
          enabled: { type: "boolean" },
          approval: { enum: ["always", "read-only"] },
        },
      },
    },
  },
});

export function parseMcpDraft(value: unknown): McpServerDraft {
  if (!validate(value))
    throw new Error("服务配置格式不正确，请检查名称、地址和工具列表");
  const draft = value as McpServerDraft;
  if (!draft.name.trim()) throw new Error("请填写服务名称");
  if (new Set(draft.tools.map((tool) => tool.name)).size !== draft.tools.length)
    throw new Error("工具名称不能重复");
  if (draft.enabled && !draft.tools.some((tool) => tool.enabled))
    throw new Error("请至少允许一个工具，再启用服务");
  if (draft.tools.filter((tool) => tool.enabled).length > 32)
    throw new Error("每个服务最多允许 32 个工具");
  if (draft.clearToken && draft.token?.trim())
    throw new Error("清除 Token 与填写新 Token 不能同时进行");
  return {
    ...draft,
    name: draft.name.trim(),
    url: draft.url.trim(),
    token: draft.token?.trim(),
  };
}

async function publicUrl(value: string) {
  try {
    const url = new URL(value);
    // User-entered endpoints only support public HTTPS hostnames.
    if (url.protocol !== "https:" || url.hostname.includes(":"))
      throw new Error();
    await assertPublicProviderUrl(value);
    return url.toString();
  } catch {
    throw new Error(
      "请填写可访问的公网 HTTPS MCP 地址，不能包含凭据或查询参数",
    );
  }
}

function storageError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "42P01" || error.code === "PGRST205")
    throw new Error("MCP 配置存储尚未初始化，请联系管理员完成数据库更新");
  throw new Error("MCP 配置读写失败，请稍后重试");
}

async function rows(userId: string): Promise<Row[]> {
  const { data, error } = await getSupabase()
    .from("user_mcp_servers")
    .select(columns)
    .eq("user_id", userId)
    .order("created_at");
  storageError(error);
  return data ?? [];
}

async function row(userId: string, id: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("服务不存在");
  const { data, error } = await getSupabase()
    .from("user_mcp_servers")
    .select(columns)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  storageError(error);
  if (!data) throw new Error("服务不存在或无权访问");
  return data;
}

function view(value: Row): McpServerView {
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    enabled: value.enabled,
    tokenConfigured: Boolean(value.token_ciphertext),
    tools: value.tools,
    updatedAt: value.updated_at,
  };
}

export async function listMcpServers(
  userId: string,
): Promise<{ servers: McpServerView[]; storageReady: boolean }> {
  let owned: Row[] = [];
  let storageReady = true;
  try {
    owned = await rows(userId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("尚未初始化"))
      storageReady = false;
    else throw error;
  }
  return { servers: owned.map(view), storageReady };
}

function resolveToken(
  draft: Pick<McpServerDraft, "url" | "token" | "clearToken">,
  existing?: Row,
) {
  if (draft.clearToken) return "";
  if (draft.token?.trim()) return draft.token.trim();
  if (existing?.token_ciphertext) {
    if (new URL(draft.url).toString() !== existing.url)
      throw new Error("更换服务地址时，请重新填写 Token 或选择清除 Token");
    return decryptRuntimeConfigValue(existing.token_ciphertext);
  }
  return "";
}

export async function saveMcpServer(
  userId: string,
  value: unknown,
  id?: string,
) {
  const draft = parseMcpDraft(value);
  const existing = id ? await row(userId, id) : undefined;
  if (!id && (await rows(userId)).length >= 8)
    throw new Error("最多添加 8 个 MCP 服务");
  const url = await publicUrl(draft.url);
  const token = resolveToken({ ...draft, url }, existing);
  const payload = {
    name: draft.name,
    url,
    enabled: draft.enabled,
    tools: draft.tools,
    token_ciphertext: token ? encryptRuntimeConfigValue(token) : "",
    updated_at: new Date().toISOString(),
  };
  const table = getSupabase().from("user_mcp_servers");
  const query = id
    ? table.update(payload).eq("user_id", userId).eq("id", id)
    : table.insert({ ...payload, user_id: userId });
  const { data, error } = await query.select(columns).single();
  storageError(error);
  return view(data);
}

export async function deleteMcpServer(userId: string, id: string) {
  await row(userId, id);
  const { error } = await getSupabase()
    .from("user_mcp_servers")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);
  storageError(error);
}

function runtimeConfig(
  value: Pick<Row, "id" | "name" | "url" | "tools">,
): McpServerConfig {
  return {
    id: `u_${value.id.replace(/-/g, "").slice(0, 30)}`,
    name: value.name,
    url: value.url,
    tools: value.tools
      .filter((tool) => tool.enabled)
      .map((tool) => ({
        name: tool.name,
        riskLevel: tool.approval === "read-only" ? "safe" : "confirm",
        sideEffect: tool.approval === "read-only" ? "read" : "external",
        timeoutSeconds: 30,
      })),
  };
}

export async function discoverUserMcpTools(
  userId: string,
  value: unknown,
  signal: AbortSignal,
): Promise<McpDiscoveryResult> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求格式不正确");
  const body = value as Record<string, unknown>;
  if (
    typeof body.url !== "string" ||
    body.url.length > 2048 ||
    (body.id !== undefined && typeof body.id !== "string") ||
    (body.token !== undefined &&
      (typeof body.token !== "string" || body.token.length > 4000)) ||
    (body.clearToken !== undefined && typeof body.clearToken !== "boolean")
  )
    throw new Error("服务地址或 Token 格式不正确");
  const existing = body.id ? await row(userId, body.id as string) : undefined;
  const url = await publicUrl(body.url);
  const token = resolveToken(
    {
      url,
      token: body.token as string | undefined,
      clearToken: body.clearToken as boolean | undefined,
    },
    existing,
  );
  const startedAt = Date.now();
  try {
    const session = await connectMcpServer(
      {
        id: "discovery",
        url,
        tools: [],
      },
      { userId, signal },
      token,
    );
    try {
      return {
        tools: session.discoveredTools
          .filter((tool) => tool.name.length <= 128)
          .map((tool) => ({
            name: tool.name,
            description: (tool.description ?? "").slice(0, 2000),
          }))
          .slice(0, 256),
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      await session.close();
    }
  } catch {
    throw new Error(
      "连接失败，请检查 MCP 地址、认证信息以及服务是否支持 Streamable HTTP",
    );
  }
}

export function createManagedMcpToolsPort(): ExternalToolsPort {
  return {
    async open(input) {
      input.signal.throwIfAborted();
      let owned: Row[];
      try {
        owned = await rows(input.userId);
      } catch {
        input.signal.throwIfAborted();
        return { tools: [], close: async () => {} };
      }
      const results = await Promise.allSettled(
        owned
          .filter(
            (server) =>
              server.enabled && server.tools.some((tool) => tool.enabled),
          )
          .slice(0, 8)
          .map(async (server) => {
            const config = runtimeConfig(server);
            return connectMcpServer(
              config,
              input,
              server.token_ciphertext
                ? decryptRuntimeConfigValue(server.token_ciphertext)
                : "",
            );
          }),
      );
      const sessions = [
        ...results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      ];
      const close = async () => {
        await Promise.allSettled(sessions.map((session) => session.close()));
      };
      if (input.signal.aborted) {
        await close();
        input.signal.throwIfAborted();
      }
      return { tools: sessions.flatMap((session) => session.tools), close };
    },
  };
}
