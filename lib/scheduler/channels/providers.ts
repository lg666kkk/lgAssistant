import type { ResolvedNotificationChannel } from "./types";

const MAX_TELEGRAM_TEXT = 4000;
const MAX_WECOM_TEXT = 3500;

function chunks(text: string, maxLength: number) {
  const normalized = text.trim() || "定时任务已执行完成。";
  const result: string[] = [];
  for (let start = 0; start < normalized.length; start += maxLength) {
    result.push(normalized.slice(start, start + maxLength));
  }
  return result;
}

async function responseJson(response: Response) {
  try {
    return await response.json() as Record<string, any>;
  } catch {
    return {};
  }
}

export async function sendNotification(
  channel: ResolvedNotificationChannel,
  text: string,
): Promise<{ messageId?: string }> {
  if (channel.provider === "telegram" && channel.telegram) {
    let messageId: string | undefined;
    for (const part of chunks(text, MAX_TELEGRAM_TEXT)) {
      const response = await fetch(
        `https://api.telegram.org/bot${channel.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: channel.telegram.chatId, text: part }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = await responseJson(response);
      if (!response.ok || body.ok === false) {
        throw new Error(`Telegram 推送失败: ${body.description ?? response.status}`);
      }
      if (body.result?.message_id !== undefined) messageId = String(body.result.message_id);
    }
    return { messageId };
  }

  if (channel.provider === "wecom" && channel.wecom) {
    for (const part of chunks(text, MAX_WECOM_TEXT)) {
      const response = await fetch(channel.wecom.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: part } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await responseJson(response);
      if (!response.ok || Number(body.errcode ?? 0) !== 0) {
        throw new Error(`企业微信推送失败: ${body.errmsg ?? response.status}`);
      }
    }
    return {};
  }

  throw new Error(`不支持的消息通道: ${channel.provider}`);
}
