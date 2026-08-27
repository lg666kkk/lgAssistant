import { requireUser } from "@/lib/auth/server";
import {
  listUserSearchCatalog,
  updateUserSearchCatalog,
} from "@/lib/search/config-service";
import type { SearchProviderId } from "@/lib/search/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json(await listUserSearchCatalog(user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取搜索引擎配置失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: {
    defaultProvider?: unknown;
    providers?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.defaultProvider !== "string" || !Array.isArray(body.providers)) {
    return Response.json({ error: "搜索引擎配置格式错误" }, { status: 400 });
  }
  try {
    await updateUserSearchCatalog({
      userId: user.id,
      defaultProvider: body.defaultProvider as SearchProviderId,
      providers: body.providers as Array<{
        id: SearchProviderId;
        apiKey?: string;
        enabled: boolean;
      }>,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "保存搜索引擎配置失败" },
      { status: 400 },
    );
  }
}
