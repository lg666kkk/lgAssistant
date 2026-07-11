import { requireUser } from "@/lib/auth/server";
import { resetKnowledgeBase } from "@/lib/server/knowledge-reset";

export const runtime = "nodejs";

type ResetRequestBody = {
  confirm?: boolean;
  includeRag?: boolean;
  includeCompiledWiki?: boolean;
};

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: ResetRequestBody;

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体格式错误，需要 JSON" }, { status: 400 });
  }

  try {
    const result = await resetKnowledgeBase({
      userId: user.id,
      confirm: body.confirm === true,
      includeRag: body.includeRag !== false,
      includeCompiledWiki: body.includeCompiledWiki !== false,
    });

    return Response.json(result, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "清空知识库失败" },
      { status: 500 },
    );
  }
}
