import { compileWiki } from "@/lib/knowledge/wiki-compiler";
import { requireUser } from "@/lib/auth/server";
import { withUserLangfuseTrace } from "@/lib/langfuse/client";
import {
  withSpanLabel,
} from "@/lib/agent/observability/span-labels";

export const runtime = "nodejs";

function streamEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: Record<string, unknown>,
) {
  controller.enqueue(
    encoder.encode(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`),
  );
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: { pageIds?: string[]; force?: boolean };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }

  const requestId = crypto.randomUUID();
  const pageIds = Array.isArray(body.pageIds) && body.pageIds.length > 0 ? body.pageIds : undefined;
  const force = Boolean(body.force);
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const traceInput = {
        requestId,
        userId: user.id,
        pageIds,
        force,
      };

      await withUserLangfuseTrace({
        userId: user.id,
        name: "knowledge-wiki-compile",
        traceInput,
        tags: ["knowledge", "wiki-compile"],
        metadata: withSpanLabel("knowledge-wiki-compile", {
          requestId,
          userId: user.id,
          pageCount: pageIds?.length,
          force,
        }),
      }, async (langfuseTrace) => {
        langfuseTrace.update({
          input: traceInput,
          metadata: withSpanLabel("knowledge-wiki-compile", {
            requestId,
            userId: user.id,
            pageCount: pageIds?.length,
            force,
          }),
        });
        langfuseTrace.setTraceIO({ input: traceInput });

          try {
            const results = await compileWiki({
              pageIds,
              userId: user.id,
              force,
              onEvent: (event) => streamEvent(controller, encoder, event),
            });

            langfuseTrace.update({
              output: {
                completed: true,
                results,
              },
            });
            langfuseTrace.setTraceIO({
              input: traceInput,
              output: results,
            });

            streamEvent(controller, encoder, {
              type: "done",
              message: "编译任务结束",
              results,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "编译失败";
            langfuseTrace.update({
              output: {
                completed: false,
                error: message,
              },
              level: "ERROR",
              statusMessage: message,
            });
            langfuseTrace.setTraceIO({
              input: traceInput,
              output: { error: message },
            });
            streamEvent(controller, encoder, {
              type: "error",
              message,
            });
          } finally {
            controller.close();
          }
      });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
