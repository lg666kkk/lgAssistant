import { requireUser } from "@/lib/auth/server";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import { resolveUserMemoryConfig } from "@/lib/memory-config/service";
import { createConfiguredMemoryReranker } from "@/lib/agent/memory/memory-reranker";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { url?: unknown; apiKey?: unknown; model?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 空请求体测试已保存配置。
  }
  if (
    (body.url !== undefined && typeof body.url !== "string")
    || (body.apiKey !== undefined && typeof body.apiKey !== "string")
    || (body.model !== undefined && typeof body.model !== "string")
  ) return Response.json({ error: "测试配置格式错误" }, { status: 400 });
  try {
    const saved = await resolveUserMemoryConfig(user.id);
    if (!saved) throw new Error("请先保存当前用户的记忆设置");
    const config = {
      ...saved.rerank,
      enabled: true,
      url: body.url?.trim() ? await assertPublicProviderUrl(body.url) : saved.rerank.url,
      apiKey: body.apiKey?.trim() || saved.rerank.apiKey,
      model: body.model?.trim() || saved.rerank.model,
    };
    config.configured = Boolean(config.url && config.apiKey);
    const reranker = createConfiguredMemoryReranker(config);
    if (!reranker) throw new Error("请先配置 Rerank URL 和 API Key");
    const startedAt = Date.now();
    const scores = await reranker.rerank({
      query: "用户喜欢什么饮料",
      documents: [{ id: "test", text: "用户偏好喝咖啡" }],
    });
    return Response.json({ ok: true, latencyMs: Date.now() - startedAt, resultCount: scores.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "记忆重排连接测试失败" }, { status: 400 });
  }
}
