import { requireUser } from "@/lib/auth/server";
import {
  getUserEmbeddingConfigView,
  saveUserEmbeddingConfig,
} from "@/lib/embedding-config/service";
import type { EmbeddingProviderId } from "@/lib/embedding-config/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await getUserEmbeddingConfigView(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取向量嵌入配置失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.provider !== "string" || typeof body.baseUrl !== "string") {
    return Response.json({ error: "向量嵌入配置格式错误" }, { status: 400 });
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    return Response.json({ error: "API Key 格式错误" }, { status: 400 });
  }
  try {
    await saveUserEmbeddingConfig({
      userId: user.id,
      provider: body.provider as EmbeddingProviderId,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存向量嵌入配置失败" },
      { status: 400 },
    );
  }
}

