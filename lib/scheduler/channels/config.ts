import { getSupabase } from "@/lib/platform/supabase";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import type { NotificationProvider } from "@/lib/scheduler/types";
import type {
  NotificationChannelView,
  ResolvedNotificationChannel,
} from "./types";

const PROVIDER_LABELS: Record<NotificationProvider, string> = {
  telegram: "Telegram Bot",
  wecom: "企业微信群机器人",
};

type ChannelRow = {
  user_id: string;
  provider: NotificationProvider;
  enabled: boolean;
  credentials_ciphertext: string;
  credentials_hint: string;
  settings: { chatId?: string } | null;
  revision: number;
  last_test_status: "success" | "failed" | null;
  last_test_error: string | null;
  last_tested_at: string | null;
  updated_at: string;
};

function isMissingTable(error: { code?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function validateTelegramToken(value: string) {
  const token = value.trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("Telegram Bot Token 格式无效");
  }
  return token;
}

function validateTelegramChatId(value: string) {
  const chatId = value.trim();
  if (!/^-?\d+$/.test(chatId)) throw new Error("Telegram Chat ID 格式无效");
  return chatId;
}

export function validateWeComWebhookUrl(value: string) {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("企业微信 Webhook URL 格式无效");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "qyapi.weixin.qq.com"
    || url.pathname !== "/cgi-bin/webhook/send"
    || !url.searchParams.get("key")
  ) {
    throw new Error("只允许企业微信群机器人的官方 HTTPS Webhook URL");
  }
  return url.toString();
}

function secretHint(value: string) {
  const trimmed = value.trim();
  return trimmed.length < 10
    ? "已配置"
    : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

async function readRows(userId: string): Promise<ChannelRow[]> {
  const { data, error } = await getSupabase()
    .from("user_notification_channels")
    .select("user_id,provider,enabled,credentials_ciphertext,credentials_hint,settings,revision,last_test_status,last_test_error,last_tested_at,updated_at")
    .eq("user_id", userId);
  if (error) {
    if (isMissingTable(error)) {
      throw new Error("消息通道数据表尚未创建，请先执行 20260904-reliable-scheduler-channels.sql");
    }
    throw new Error(`读取消息通道失败: ${error.message}`);
  }
  return (data ?? []) as ChannelRow[];
}

function toView(provider: NotificationProvider, row?: ChannelRow): NotificationChannelView {
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    enabled: row?.enabled ?? false,
    configured: Boolean(row?.credentials_ciphertext),
    credentialsHint: row?.credentials_hint ?? "",
    settings: row?.settings ?? {},
    revision: row?.revision ?? 0,
    lastTestStatus: row?.last_test_status ?? undefined,
    lastTestError: row?.last_test_error ?? undefined,
    lastTestedAt: row?.last_tested_at ?? undefined,
    updatedAt: row?.updated_at,
  };
}

export async function listNotificationChannels(userId: string) {
  const rows = await readRows(userId);
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return (["telegram", "wecom"] as const).map((provider) =>
    toView(provider, byProvider.get(provider))
  );
}

export async function updateNotificationChannel(input: {
  userId: string;
  provider: NotificationProvider;
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
}) {
  const existing = (await readRows(input.userId)).find((row) => row.provider === input.provider);
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    provider: input.provider,
    enabled: input.enabled,
    revision: (existing?.revision ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };

  if (input.provider === "telegram") {
    const botToken = input.botToken?.trim();
    const rawChatId = input.chatId?.trim();
    const chatId = rawChatId
      ? validateTelegramChatId(rawChatId)
      : existing?.settings?.chatId;
    if (botToken) {
      const validated = validateTelegramToken(botToken);
      payload.credentials_ciphertext = encryptRuntimeConfigValue(validated);
      payload.credentials_hint = secretHint(validated);
    } else if (!existing) {
      payload.credentials_ciphertext = "";
      payload.credentials_hint = "";
    }
    payload.settings = { chatId };
    if (input.enabled && (!chatId || (!botToken && !existing?.credentials_ciphertext))) {
      throw new Error("启用 Telegram 前必须配置 Bot Token 和 Chat ID");
    }
  } else {
    const webhookUrl = input.webhookUrl?.trim();
    if (webhookUrl) {
      const validated = validateWeComWebhookUrl(webhookUrl);
      payload.credentials_ciphertext = encryptRuntimeConfigValue(validated);
      payload.credentials_hint = secretHint(new URL(validated).searchParams.get("key") ?? "");
    } else if (!existing) {
      payload.credentials_ciphertext = "";
      payload.credentials_hint = "";
    }
    payload.settings = {};
    if (input.enabled && !webhookUrl && !existing?.credentials_ciphertext) {
      throw new Error("启用企业微信前必须配置群机器人 Webhook URL");
    }
  }

  const { error } = await getSupabase()
    .from("user_notification_channels")
    .upsert(payload, { onConflict: "user_id,provider" });
  if (error) throw new Error(`保存消息通道失败: ${error.message}`);
  return (await listNotificationChannels(input.userId)).find(
    (channel) => channel.provider === input.provider,
  )!;
}

export async function resolveNotificationChannel(input: {
  userId: string;
  provider: NotificationProvider;
}): Promise<ResolvedNotificationChannel> {
  const row = (await readRows(input.userId)).find((item) => item.provider === input.provider);
  if (!row?.enabled) throw new Error(`${PROVIDER_LABELS[input.provider]} 尚未启用`);
  if (!row.credentials_ciphertext) throw new Error(`${PROVIDER_LABELS[input.provider]} 尚未配置凭证`);
  const secret = decryptRuntimeConfigValue(row.credentials_ciphertext);
  if (input.provider === "telegram") {
    if (!row.settings?.chatId) throw new Error("Telegram Chat ID 尚未配置");
    return {
      provider: "telegram",
      userId: input.userId,
      telegram: { botToken: secret, chatId: row.settings.chatId },
    };
  }
  return {
    provider: "wecom",
    userId: input.userId,
    wecom: { webhookUrl: secret },
  };
}

export async function recordNotificationChannelTest(input: {
  userId: string;
  provider: NotificationProvider;
  ok: boolean;
  error?: string;
}) {
  const { error } = await getSupabase()
    .from("user_notification_channels")
    .update({
      last_test_status: input.ok ? "success" : "failed",
      last_test_error: input.error?.slice(0, 500) ?? null,
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", input.userId)
    .eq("provider", input.provider);
  if (error) throw new Error(`记录消息通道测试失败: ${error.message}`);
}
