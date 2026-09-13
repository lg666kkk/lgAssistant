import { randomUUID } from "node:crypto";
import { confirmTool } from "@repo/application/mcp/confirm-tool";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";
import { requireUser } from "@/lib/auth/server";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body;

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误" }, { status: 400 });
  }

  const { toolCall, sessionId } = body ?? {};

  if (!toolCall || typeof toolCall !== "object") {
    return Response.json({ error: "缺少 toolCall" }, { status: 400 });
  }

  if (typeof toolCall.name !== "string") {
    return Response.json({ error: "toolCall.name 必须是字符串" }, { status: 400 });
  }

  const result = await confirmTool({
    userId: user.id,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    requestId: randomUUID(),
    signal: req.signal,
    toolCall: { id: typeof toolCall.id === "string" ? toolCall.id : undefined, name: toolCall.name, input: toolCall.input },
    dependencies: createProductionChatDependencies(),
  });

  return Response.json(result);
}
