import { requireUser } from "@/lib/auth/server";
import {
  getUserNotionConnection,
  updateUserNotionConnection,
} from "@/lib/knowledge/connections/notion-config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserNotionConnection(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取 Notion 配置失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    enabled?: unknown;
    token?: unknown;
    defaultRecursive?: unknown;
    maxDepth?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (
    typeof body.enabled !== "boolean"
    || (body.token !== undefined && typeof body.token !== "string")
    || typeof body.defaultRecursive !== "boolean"
    || typeof body.maxDepth !== "number"
  ) {
    return Response.json({ error: "Notion 配置格式错误" }, { status: 400 });
  }
  try {
    return Response.json(await updateUserNotionConnection({
      userId: user.id,
      enabled: body.enabled,
      token: body.token,
      defaultRecursive: body.defaultRecursive,
      maxDepth: body.maxDepth,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存 Notion 配置失败" },
      { status: 400 },
    );
  }
}
