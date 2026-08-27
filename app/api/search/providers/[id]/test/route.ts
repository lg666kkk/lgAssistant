import { requireUser } from "@/lib/auth/server";
import {
  isSearchProviderId,
  resolveUserSearchProviderCredentials,
} from "@/lib/search/config-service";
import { testSearchProviderConnection } from "@/lib/search/connection-test";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  if (!isSearchProviderId(params.id)) {
    return Response.json({ error: "搜索引擎类型无效" }, { status: 400 });
  }

  let body: { apiKey?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // 空请求体表示测试已保存的密钥。
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
    return Response.json({ error: "API Key 格式错误" }, { status: 400 });
  }

  try {
    const provider = await resolveUserSearchProviderCredentials({
      userId: user.id,
      provider: params.id,
      apiKey: body.apiKey,
    });
    return Response.json(await testSearchProviderConnection(provider));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "搜索引擎连接测试失败" },
      { status: 400 },
    );
  }
}
