import { requireUser } from "@/lib/auth/server";
import { appendUserLlmAudit, resolveUserLlmModel } from "@/lib/llm/config-service";
import { testUserLlmConnection } from "@/lib/llm/connection-test";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { modelId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.modelId !== "string") {
    return Response.json({ error: "请选择要测试的模型" }, { status: 400 });
  }
  try {
    const model = await resolveUserLlmModel(user.id, body.modelId);
    if (model.providerId !== params.id) throw new Error("模型不属于当前 Provider");
    const result = await testUserLlmConnection(model);
    await appendUserLlmAudit({
      userId: user.id,
      action: "connection_test",
      targetId: params.id,
      metadata: { modelId: model.id, latencyMs: result.latencyMs, ok: true },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "连接测试失败" },
      { status: 400 },
    );
  }
}
