import { syncNotionPageTree, syncNotionPages } from "@/lib/server/sync";
import { requireUser } from "@/lib/auth/server";

export const runtime = "nodejs";

function extractNotionPageId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const compact = trimmed.match(/[0-9a-fA-F]{32}/);
  if (compact) return compact[0].toLowerCase();

  const uuid = trimmed.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  if (uuid) return uuid[0].replace(/-/g, "").toLowerCase();

  return null;
}

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

  let body: { input?: string; tree?: boolean; force?: boolean };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }

  const pageId = extractNotionPageId(body.input ?? "");
  const syncTree = body.tree !== false;
  const force = Boolean(body.force);

  if (!pageId) {
    return Response.json({ error: "请输入有效的 Notion 页面链接或页面 ID" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        streamEvent(controller, encoder, {
          type: "input_parsed",
          message: `已解析页面 ID：${pageId}`,
          pageId,
          tree: syncTree,
          force,
        });

        const results = syncTree
          ? await syncNotionPageTree(pageId, {
              userId: user.id,
              force,
              onEvent: (event) => streamEvent(controller, encoder, event),
            })
          : await syncNotionPages([pageId], {
              userId: user.id,
              force,
              onEvent: (event) => streamEvent(controller, encoder, event),
            });

        streamEvent(controller, encoder, {
          type: "done",
          message: "同步任务结束",
          results,
        });
      } catch (error) {
        streamEvent(controller, encoder, {
          type: "error",
          message: error instanceof Error ? error.message : "同步失败",
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
