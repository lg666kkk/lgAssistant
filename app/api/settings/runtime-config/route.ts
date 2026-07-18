import { requireConfigAdmin, requireUser } from "@/lib/auth/server";
import { listRuntimeConfig, upsertRuntimeConfig } from "@/lib/runtime-config/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  try {
    return Response.json({
      canEdit: await requireConfigAdmin(req, user),
      items: await listRuntimeConfig(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取运行时配置失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (!(await requireConfigAdmin(req, user))) {
    return Response.json({ error: "只有配置管理员可以修改运行时配置" }, { status: 403 });
  }

  let body: { key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.key !== "string" || typeof body.value !== "string") {
    return Response.json({ error: "key 和 value 必须是字符串" }, { status: 400 });
  }

  try {
    await upsertRuntimeConfig({ key: body.key, value: body.value, actorId: user.id });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存运行时配置失败" },
      { status: 400 },
    );
  }
}
