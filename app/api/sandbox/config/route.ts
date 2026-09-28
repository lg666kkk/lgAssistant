import { requireUser } from "@/lib/auth/server";
import { getUserSandboxConfigView, saveUserSandboxConfig } from "@/lib/sandbox/config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserSandboxConfigView(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "读取沙盒配置失败",
    }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { apiKey?: unknown };
  try { body = await req.json(); }
  catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  if (typeof body.apiKey !== "string") {
    return Response.json({ error: "API Key 格式错误" }, { status: 400 });
  }
  try {
    await saveUserSandboxConfig({ userId: user.id, apiKey: body.apiKey });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "保存沙盒配置失败",
    }, { status: 400 });
  }
}
