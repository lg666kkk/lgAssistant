import { requireUser } from "@/lib/auth/server";
import { withChatSessionLease } from "@/lib/chat/session-lease";
import { compactChatContextUseCase } from "@repo/application/chat";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  return withChatSessionLease(request, user.id, async (leasedRequest) => {
    try {
      const body = await leasedRequest.json();
      if (!body || typeof body.sessionId !== "string" || !body.sessionId.trim()) {
        return Response.json({ error: "请选择要压缩的会话" }, { status: 400 });
      }
      return Response.json(await compactChatContextUseCase({
        userId: user.id, sessionId: body.sessionId,
        modelId: typeof body.model === "string" ? body.model : undefined,
        signal: leasedRequest.signal, dependencies: createProductionChatDependencies(),
      }));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "上下文压缩失败" }, { status: 400 });
    }
  });
}
