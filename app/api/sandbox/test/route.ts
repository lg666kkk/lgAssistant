import { Sandbox } from "e2b";
import { requireUser } from "@/lib/auth/server";
import { getE2BApiKey, recordSandboxConnectionTest } from "@/lib/sandbox/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const apiKey = await getE2BApiKey(user.id);
    const startedAt = Date.now();
    await Sandbox.list({ apiKey, limit: 1 }).nextItems();
    const latencyMs = Date.now() - startedAt;
    await recordSandboxConnectionTest({ userId: user.id, status: "ok", latencyMs }).catch((error) => {
      console.error("记录 E2B 连接测试失败:", error);
    });
    return Response.json({ ok: true, latencyMs });
  } catch (error) {
    await recordSandboxConnectionTest({ userId: user.id, status: "error" }).catch(() => undefined);
    return Response.json({
      error: error instanceof Error ? error.message : "E2B 连接测试失败",
    }, { status: 400 });
  }
}
