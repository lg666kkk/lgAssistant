import { requireUser } from "@/lib/auth/server";
import {
  deleteUserLlmProvider,
  updateUserLlmProvider,
} from "@/lib/llm/config-service";
import type { UserLlmModelDraft } from "@/lib/llm/types";

export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    name?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    enabled?: unknown;
    models?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (
    typeof body.name !== "string"
    || typeof body.baseUrl !== "string"
    || typeof body.enabled !== "boolean"
    || (body.apiKey !== undefined && typeof body.apiKey !== "string")
    || !Array.isArray(body.models)
  ) {
    return Response.json({ error: "Provider 配置格式错误" }, { status: 400 });
  }
  try {
    await updateUserLlmProvider({
      userId: user.id,
      providerId: params.id,
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      enabled: body.enabled,
      models: body.models as UserLlmModelDraft[],
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "更新 Provider 失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    await deleteUserLlmProvider(user.id, params.id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "删除 Provider 失败" },
      { status: 400 },
    );
  }
}

