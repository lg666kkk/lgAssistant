import { requireUser } from "@/lib/auth/server";
import { testJevConnection } from "@/lib/jev/client";
import { recordJevConnectionTest, resolveUserJevConfig } from "@/lib/jev/service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const result = await testJevConnection(await resolveUserJevConfig(user.id));
    await recordJevConnectionTest({ userId: user.id, status: "ok", latencyMs: result.latencyMs });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Jev 连接测试失败";
    await recordJevConnectionTest({ userId: user.id, status: "error", error: message }).catch(() => undefined);
    return Response.json({ error: message }, { status: 400 });
  }
}
