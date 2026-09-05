import { requireUser } from "@/lib/auth/server";
import {
  recordNotificationChannelTest,
  resolveNotificationChannel,
} from "@/lib/scheduler/channels/config";
import { sendNotification } from "@/lib/scheduler/channels/providers";
import type { NotificationProvider } from "@/lib/scheduler/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: { provider?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体必须是 JSON" }, { status: 400 });
  }
  const provider = body.provider as NotificationProvider;
  if (provider !== "telegram" && provider !== "wecom") {
    return Response.json({ ok: false, error: "未知消息通道" }, { status: 400 });
  }
  try {
    const channel = await resolveNotificationChannel({ userId: user.id, provider });
    await sendNotification(channel, `个人助理消息通道连接成功。\n测试时间：${new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`);
    await recordNotificationChannelTest({ userId: user.id, provider, ok: true });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "消息通道测试失败";
    await recordNotificationChannelTest({ userId: user.id, provider, ok: false, error: message }).catch(() => undefined);
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
