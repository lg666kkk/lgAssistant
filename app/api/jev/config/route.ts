import { requireUser } from "@/lib/auth/server";
import { getUserJevConfigView, saveUserJevConfig } from "@/lib/jev/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try { return Response.json(await getUserJevConfigView(user.id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "读取 Jev 配置失败" }, { status: 503 }); }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { baseUrl?: unknown; apiKey?: unknown; modelId?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  if (typeof body.baseUrl !== "string" || typeof body.modelId !== "string" || (body.apiKey !== undefined && typeof body.apiKey !== "string")) {
    return Response.json({ error: "Jev 配置格式错误" }, { status: 400 });
  }
  try {
    await saveUserJevConfig({ userId: user.id, baseUrl: body.baseUrl, apiKey: body.apiKey, modelId: body.modelId });
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "保存 Jev 配置失败" }, { status: 400 }); }
}
