import { compileWiki } from "@/lib/server/wiki-compiler";

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
  let body: { pageIds?: string[]; force?: boolean };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const results = await compileWiki({
          pageIds: Array.isArray(body.pageIds) && body.pageIds.length > 0 ? body.pageIds : undefined,
          force: Boolean(body.force),
          onEvent: (event) => streamEvent(controller, encoder, event),
        });

        streamEvent(controller, encoder, {
          type: "done",
          message: "编译任务结束",
          results,
        });
      } catch (error) {
        streamEvent(controller, encoder, {
          type: "error",
          message: error instanceof Error ? error.message : "编译失败",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
