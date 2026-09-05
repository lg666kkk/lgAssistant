import { getSupabase } from "@/lib/platform/supabase";
import {
  resolveNotificationChannel,
} from "@/lib/scheduler/channels/config";
import { sendNotification } from "@/lib/scheduler/channels/providers";
import type { NotificationProvider, ScheduledDelivery } from "@/lib/scheduler/types";

type DeliveryRow = {
  id: string;
  run_id: number;
  job_id: string;
  user_id: string;
  provider: NotificationProvider;
  status: ScheduledDelivery["status"];
  text: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number;
  provider_message_id: string | null;
  last_error: string | null;
};

function toDelivery(row: DeliveryRow): ScheduledDelivery {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    userId: row.user_id,
    provider: row.provider,
    status: row.status,
    text: row.text,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
  };
}

async function claimDueDeliveries(input: {
  workerId: string;
  now: number;
  limit?: number;
}): Promise<ScheduledDelivery[]> {
  const { data, error } = await getSupabase().rpc("claim_due_scheduled_deliveries", {
    p_now: input.now,
    p_worker_id: input.workerId,
    p_lease_ms: 60_000,
    p_limit: input.limit ?? 20,
  });
  if (error) throw new Error(`领取消息投递失败: ${error.message}`);
  return ((data ?? []) as DeliveryRow[]).map(toDelivery);
}

async function markDelivered(delivery: ScheduledDelivery, messageId?: string) {
  const { error } = await getSupabase()
    .from("scheduled_deliveries")
    .update({
      status: "delivered",
      provider_message_id: messageId ?? null,
      last_error: null,
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", delivery.id);
  if (error) throw new Error(`更新消息投递成功状态失败: ${error.message}`);
}

async function markDeliveryFailure(delivery: ScheduledDelivery, cause: unknown, now: number) {
  const dead = delivery.attemptCount >= delivery.maxAttempts;
  const backoffMs = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.max(0, delivery.attemptCount - 1));
  const message = cause instanceof Error ? cause.message : String(cause);
  const { error } = await getSupabase()
    .from("scheduled_deliveries")
    .update({
      status: dead ? "dead" : "retry_wait",
      next_attempt_at: dead ? delivery.nextAttemptAt : now + backoffMs,
      last_error: message.slice(0, 1000),
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", delivery.id);
  if (error) throw new Error(`更新消息投递失败状态失败: ${error.message}`);
}

export type DeliveryTickResult = {
  due: number;
  delivered: number;
  failed: number;
  dead: number;
};

export async function deliverDueNotifications(input: {
  workerId: string;
  now?: number;
  limit?: number;
}): Promise<DeliveryTickResult> {
  const now = input.now ?? Date.now();
  const deliveries = await claimDueDeliveries({
    workerId: input.workerId,
    now,
    limit: input.limit,
  });
  const result: DeliveryTickResult = {
    due: deliveries.length,
    delivered: 0,
    failed: 0,
    dead: 0,
  };
  for (const delivery of deliveries) {
    try {
      const channel = await resolveNotificationChannel({
        userId: delivery.userId,
        provider: delivery.provider,
      });
      const sent = await sendNotification(channel, delivery.text);
      await markDelivered(delivery, sent.messageId);
      result.delivered += 1;
    } catch (error) {
      await markDeliveryFailure(delivery, error, now);
      result.failed += 1;
      if (delivery.attemptCount >= delivery.maxAttempts) result.dead += 1;
    }
  }
  return result;
}

export async function listRecentDeliveries(userId: string, limit = 50) {
  const { data, error } = await getSupabase()
    .from("scheduled_deliveries")
    .select("id,run_id,job_id,user_id,provider,status,text,attempt_count,max_attempts,next_attempt_at,provider_message_id,last_error")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`读取消息投递记录失败: ${error.message}`);
  return ((data ?? []) as DeliveryRow[]).map(toDelivery);
}
