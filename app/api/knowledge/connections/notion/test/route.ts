import { requireUser } from "@/lib/auth/server";
import {
  recordNotionConnectionTest,
  resolveUserNotionTokenWithOverride,
} from "@/lib/knowledge/connections/notion-config";
import { testNotionConnection } from "@/lib/knowledge/connections/notion-test";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (body.token !== undefined && typeof body.token !== "string") {
    return Response.json({ error: "Notion 测试配置格式错误" }, { status: 400 });
  }
  try {
    const token = await resolveUserNotionTokenWithOverride({
      userId: user.id,
      token: body.token,
    });
    const result = await testNotionConnection(token);
    await recordNotionConnectionTest({ userId: user.id, ok: true }).catch(() => undefined);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notion 连接测试失败";
    await recordNotionConnectionTest({ userId: user.id, ok: false, error: message }).catch(() => undefined);
    return Response.json({ error: message }, { status: 400 });
  }
}
