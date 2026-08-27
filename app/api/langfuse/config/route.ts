import { requireUser } from "@/lib/auth/server";
import {
  getUserLangfuseConfig,
  updateUserLangfuseConfig,
} from "@/lib/langfuse/config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserLangfuseConfig(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取 Langfuse 配置失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    enabled?: unknown;
    baseUrl?: unknown;
    publicKey?: unknown;
    secretKey?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (
    typeof body.enabled !== "boolean"
    || typeof body.baseUrl !== "string"
    || (body.publicKey !== undefined && typeof body.publicKey !== "string")
    || (body.secretKey !== undefined && typeof body.secretKey !== "string")
  ) {
    return Response.json({ error: "Langfuse 配置格式错误" }, { status: 400 });
  }
  try {
    await updateUserLangfuseConfig({
      userId: user.id,
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      publicKey: body.publicKey,
      secretKey: body.secretKey,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存 Langfuse 配置失败" },
      { status: 400 },
    );
  }
}
