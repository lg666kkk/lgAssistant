import { requireUser } from "@/lib/auth/server";
import {
  listMcpServers,
  saveMcpServer,
} from "@repo/infrastructure/mcp/user-config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    return Response.json(await listMcpServers(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取 MCP 配置失败" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  try {
    return Response.json(
      { server: await saveMcpServer(user.id, body) },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存 MCP 配置失败" },
      { status: 400 },
    );
  }
}
