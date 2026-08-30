import { requireUser } from "@/lib/auth/server";
import { testEmbeddingConnection } from "@/lib/embedding-config/connection-test";
import {
  recordEmbeddingConnectionTest,
  resolveUserEmbeddingCredentials,
} from "@/lib/embedding-config/service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 空请求体测试已保存配置。
  }
  try {
    const config = await resolveUserEmbeddingCredentials({
      userId: user.id,
      provider: body.provider,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    const result = await testEmbeddingConnection(config);
    await recordEmbeddingConnectionTest({
      userId: user.id,
      status: "ok",
      latencyMs: result.latencyMs,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "向量嵌入连接测试失败";
    await recordEmbeddingConnectionTest({
      userId: user.id,
      status: "error",
      error: message,
    }).catch(() => undefined);
    return Response.json({ error: message }, { status: 400 });
  }
}

