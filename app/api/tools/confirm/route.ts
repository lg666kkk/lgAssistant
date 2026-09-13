import { confirmTool } from "@repo/application/mcp/confirm-tool";
import { createProductionChatDependencies } from "@repo/infrastructure/chat";
import { requireUser } from "@/lib/auth/server";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误" }, { status: 400 });
  }
  if (
    !body ||
    typeof body.token !== "string" ||
    typeof body.callId !== "string" ||
    !["confirm", "cancel", "answer"].includes(body.action)
  ) {
    return Response.json(
      { error: "此确认记录不支持恢复，请重新发起请求" },
      { status: 400 },
    );
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        if (signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          abort.abort();
        }
      };
      // Keep proxy connections alive while the remote tool/model is working.
      const heartbeat = setInterval(() => {
        if (!signal.aborted)
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            abort.abort();
          }
      }, 15_000);
      try {
        const response = await confirmTool({
          userId: user.id,
          sessionId:
            typeof body.sessionId === "string" ? body.sessionId : undefined,
          token: body.token,
          callId: body.callId,
          action: body.action,
          answer: body.answer,
          signal,
          onEvent: send,
          dependencies: createProductionChatDependencies(),
        });
        if (response.continuationError)
          send({
            type: "error",
            error: "continuation_failed",
            message: response.continuationError,
          });
        send({ type: "done" });
      } catch (error) {
        send({
          type: "error",
          error: "confirmation_failed",
          message:
            error instanceof Error
              ? error.message
              : "确认失败，请核实执行状态后重试",
        });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* Client already disconnected. */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
