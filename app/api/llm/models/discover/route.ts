import { requireUser } from "@/lib/auth/server";
import {
  appendUserLlmAudit,
  resolveUserLlmProviderCredentials,
} from "@/lib/llm/config-service";
import { discoverOpenAICompatibleModels } from "@/lib/llm/model-discovery";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { providerId?: unknown; baseUrl?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (
    body.providerId !== undefined && typeof body.providerId !== "string"
    || body.baseUrl !== undefined && typeof body.baseUrl !== "string"
    || body.apiKey !== undefined && typeof body.apiKey !== "string"
  ) {
    return Response.json({ error: "模型发现参数格式错误" }, { status: 400 });
  }

  try {
    const saved = typeof body.providerId === "string"
      ? await resolveUserLlmProviderCredentials(user.id, body.providerId)
      : null;
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl
      : saved?.baseUrl;
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey
      : saved?.apiKey;
    if (!baseUrl || !apiKey) throw new Error("请先填写 Base URL 和 API Key");

    const models = await discoverOpenAICompatibleModels({ baseUrl, apiKey });
    await appendUserLlmAudit({
      userId: user.id,
      action: "models_discover",
      targetId: typeof body.providerId === "string" ? body.providerId : undefined,
      metadata: { count: models.length, savedProvider: Boolean(saved) },
    });
    return Response.json({ models });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "获取模型列表失败" },
      { status: 400 },
    );
  }
}

