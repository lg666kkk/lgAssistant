import { requireUser } from "@/lib/auth/server";
import {
  deleteMcpServer,
  saveMcpServer,
} from "@repo/infrastructure/mcp/user-config";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  try {
    return Response.json({
      server: await saveMcpServer(user.id, body, params.id),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存 MCP 配置失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  try {
    await deleteMcpServer(user.id, params.id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "删除 MCP 服务失败" },
      { status: 400 },
    );
  }
}
