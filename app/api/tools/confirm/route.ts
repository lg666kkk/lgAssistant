import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { executeToolCall } from "@/lib/agent/tools/tool-router";
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

  const { toolCall, sessionId } = body;

  if (!toolCall || typeof toolCall !== "object") {
    return Response.json({ error: "缺少 toolCall" }, { status: 400 });
  }

  if (typeof toolCall.name !== "string") {
    return Response.json({ error: "toolCall.name 必须是字符串" }, { status: 400 });
  }

  const registry = createBuiltinToolRegistry();

  const result = await executeToolCall(
    registry,
    {
      id: typeof toolCall.id === "string" ? toolCall.id : undefined,
      name: toolCall.name,
      input: toolCall.input,
    },
    {
      approved: true,
      scopeId: typeof sessionId === "string" ? sessionId : undefined,
      userId: user.id,
    },
  );

  return Response.json(result);
}
