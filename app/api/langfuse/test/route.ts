import { requireUser } from "@/lib/auth/server";
import { testLangfuseConnection } from "@/lib/langfuse/connection-test";
import { resolveUserLangfuseConfigWithOverrides } from "@/lib/langfuse/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    baseUrl?: unknown;
    publicKey?: unknown;
    secretKey?: unknown;
  } = {};
  try {
    body = await req.json();
  } catch {
    // 空请求体表示测试已保存配置。
  }
  if (
    (body.baseUrl !== undefined && typeof body.baseUrl !== "string")
    || (body.publicKey !== undefined && typeof body.publicKey !== "string")
    || (body.secretKey !== undefined && typeof body.secretKey !== "string")
  ) {
    return Response.json({ error: "Langfuse 测试配置格式错误" }, { status: 400 });
  }
  try {
    const config = await resolveUserLangfuseConfigWithOverrides({
      userId: user.id,
      baseUrl: body.baseUrl,
      publicKey: body.publicKey,
      secretKey: body.secretKey,
    });
    return Response.json(await testLangfuseConnection(config));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Langfuse 连接测试失败" },
      { status: 400 },
    );
  }
}
