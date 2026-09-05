import { requireUser } from "@/lib/auth/server";
import {
  listNotificationChannels,
  updateNotificationChannel,
} from "@/lib/scheduler/channels/config";
import type { NotificationProvider } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function provider(value: unknown): NotificationProvider | null {
  return value === "telegram" || value === "wecom" ? value : null;
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json({ ok: true, channels: await listNotificationChannels(user.id) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "读取消息通道失败" },
      { status: 503 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体必须是 JSON" }, { status: 400 });
  }
  const selectedProvider = provider(body.provider);
  if (!selectedProvider || typeof body.enabled !== "boolean") {
    return Response.json({ ok: false, error: "消息通道配置格式错误" }, { status: 400 });
  }
  const stringFields = ["botToken", "chatId", "webhookUrl"] as const;
  if (stringFields.some((key) => body[key] !== undefined && typeof body[key] !== "string")) {
    return Response.json({ ok: false, error: "消息通道凭证格式错误" }, { status: 400 });
  }
  try {
    const channel = await updateNotificationChannel({
      userId: user.id,
      provider: selectedProvider,
      enabled: body.enabled,
      botToken: body.botToken as string | undefined,
      chatId: body.chatId as string | undefined,
      webhookUrl: body.webhookUrl as string | undefined,
    });
    return Response.json({ ok: true, channel });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "保存消息通道失败" },
      { status: 400 },
    );
  }
}
