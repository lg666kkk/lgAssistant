import { requireUser } from "@/lib/auth/server";
import { discoverUserMcpTools } from "@repo/infrastructure/mcp/user-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  try {
    return Response.json(
      await discoverUserMcpTools(user.id, body, request.signal),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "连接测试失败" },
      { status: 400 },
    );
  }
}
