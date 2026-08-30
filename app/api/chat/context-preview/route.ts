import { requireUser } from "@/lib/auth/server";
import { previewChatContextUseCase } from "@repo/application/chat";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体格式错误，需要有效的 JSON" }, { status: 400 });
  }

  try {
    const usage = await previewChatContextUseCase({
      userId: user.id,
      dependencies: createProductionChatDependencies(),
      sessionId: body.sessionId,
      modelId: body.model,
      webSearchEnabled: body.enableWebSearch,
      draftText: body.draftText,
      imageCount: body.imageCount,
    });
    return Response.json({ usage });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "上下文预估失败" },
      { status: 400 },
    );
  }
}
