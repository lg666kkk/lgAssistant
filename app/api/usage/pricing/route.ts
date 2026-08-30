import { requireUser } from "@/lib/auth/server";
import {
  listUserMeteredModelPricing,
  updateUserMeteredModelPricing,
} from "@/lib/agent/observability/user-metered-pricing";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json({ prices: await listUserMeteredModelPricing(user.id) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取辅助模型价格失败" }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { prices?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.prices)) return Response.json({ error: "价格配置格式错误" }, { status: 400 });
  try {
    await updateUserMeteredModelPricing({ userId: user.id, prices: body.prices as never[] });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存辅助模型价格失败" }, { status: 400 });
  }
}

