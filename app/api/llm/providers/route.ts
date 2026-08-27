import { requireUser } from "@/lib/auth/server";
import {
  createUserLlmProvider,
  listUserLlmCatalog,
} from "@/lib/llm/config-service";
import type { LlmAdapterType, UserLlmModelDraft } from "@/lib/llm/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await listUserLlmCatalog(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取模型配置失败" },
      { status: 503 },
    );
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    name?: unknown;
    adapterType?: unknown;
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
    || body.adapterType !== "openai-compatible"
    || typeof body.baseUrl !== "string"
    || typeof body.apiKey !== "string"
    || !Array.isArray(body.models)
  ) {
    return Response.json({ error: "Provider 配置格式错误" }, { status: 400 });
  }
  try {
    const providerId = await createUserLlmProvider({
      userId: user.id,
      name: body.name,
      adapterType: body.adapterType as LlmAdapterType,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      enabled: body.enabled !== false,
      models: body.models as UserLlmModelDraft[],
    });
    return Response.json({ ok: true, providerId }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "创建 Provider 失败" },
      { status: 400 },
    );
  }
}

