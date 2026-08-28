import { requireUser } from "@/lib/auth/server";
import {
  getUserMemoryConfigView,
  updateUserMemoryConfig,
} from "@/lib/memory-config/service";
import type { UserMemoryConfigView } from "@/lib/memory-config/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserMemoryConfigView(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取记忆配置失败" }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { config?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!body.config || typeof body.config !== "object" || (body.apiKey !== undefined && typeof body.apiKey !== "string")) {
    return Response.json({ error: "记忆配置格式错误" }, { status: 400 });
  }
  try {
    await updateUserMemoryConfig({
      userId: user.id,
      config: body.config as UserMemoryConfigView,
      apiKey: body.apiKey,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存记忆配置失败" }, { status: 400 });
  }
}
