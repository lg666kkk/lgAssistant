import type { NotificationProvider } from "@/lib/scheduler/types";

export type NotificationChannelView = {
  provider: NotificationProvider;
  label: string;
  enabled: boolean;
  configured: boolean;
  credentialsHint: string;
  settings: { chatId?: string };
  revision: number;
  lastTestStatus?: "success" | "failed";
  lastTestError?: string;
  lastTestedAt?: string;
  updatedAt?: string;
};

export type ResolvedNotificationChannel = {
  provider: NotificationProvider;
  userId: string;
  telegram?: { botToken: string; chatId: string };
  wecom?: { webhookUrl: string };
};
