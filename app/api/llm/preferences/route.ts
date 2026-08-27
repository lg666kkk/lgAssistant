import { requireUser } from "@/lib/auth/server";
import { updateUserLlmPreferences } from "@/lib/llm/config-service";
import type { UserLlmPreferences } from "@/lib/llm/types";

export const runtime = "nodejs";

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: Partial<UserLlmPreferences>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const normalize = (value: unknown) => value === null || typeof value === "string" ? value : undefined;
  const preferences = {
    defaultModelId: normalize(body.defaultModelId),
    fastModelId: normalize(body.fastModelId),
    visionModelId: normalize(body.visionModelId),
  };
  if (Object.values(preferences).some((value) => value === undefined)) {
    return Response.json({ error: "模型路由格式错误" }, { status: 400 });
  }
  try {
    await updateUserLlmPreferences(user.id, preferences as UserLlmPreferences);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存模型路由失败" },
      { status: 400 },
    );
  }
}

