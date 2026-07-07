import { getSupabase } from "@/lib/supabase";
import { getSchedulerRedis } from "@/lib/scheduler/redis";
import type {
  ScheduledJob,
  ScheduledJobPayload,
  ScheduledJobRow,
  ScheduledJobRunStatus,
  ScheduledJobType,
} from "@/lib/scheduler/types";

const DUE_KEY = "scheduler:due";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJobDefinition(
  job: ScheduledJob,
  input: {
    type: ScheduledJobType;
    cron: string | null;
    runAt: number | null;
    timezone: string;
    payload?: ScheduledJobPayload;
  },
) {
  return (
    job.enabled &&
    job.type === input.type &&
    job.cron === input.cron &&
    job.runAt === input.runAt &&
    job.timezone === input.timezone &&
    stableStringify(job.payload ?? {}) === stableStringify(input.payload ?? {})
  );
}

function toJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    cron: row.cron,
    runAt: row.run_at,
    nextRunAt: row.next_run_at,
    timezone: row.timezone ?? "Asia/Shanghai",
    payload: row.payload ?? {},
    enabled: row.enabled ?? true,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    lastResult: row.last_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(job: ScheduledJob): ScheduledJobRow {
  return {
    id: job.id,
    user_id: job.userId,
    type: job.type,
    cron: job.cron,
    run_at: job.runAt,
    next_run_at: job.nextRunAt,
    timezone: job.timezone,
    payload: job.payload,
    enabled: job.enabled,
    last_run_at: job.lastRunAt,
    last_error: job.lastError,
    last_result: job.lastResult,
  };
}

export async function enqueueJob(jobId: string, nextRunAt: number): Promise<void> {
  await getSchedulerRedis().zadd(DUE_KEY, nextRunAt, jobId);
}

export async function removeJobFromQueue(jobId: string): Promise<void> {
  await getSchedulerRedis().zrem(DUE_KEY, jobId);
}

export async function popDueJobIds(now = Date.now()): Promise<string[]> {
  const redis = getSchedulerRedis();
  const ids = await redis.zrangebyscore(DUE_KEY, 0, now);
  if (ids.length > 0) {
    await redis.zrem(DUE_KEY, ...ids);
  }
  return ids;
}

export async function createScheduledJob(input: {
  userId: string;
  type: ScheduledJobType;
  cron: string | null;
  runAt: number | null;
  nextRunAt: number;
  timezone: string;
  payload?: ScheduledJobPayload;
}): Promise<ScheduledJob> {
  const existingJobs = await listScheduledJobs(input.userId);
  const duplicate = existingJobs.find((job) => sameJobDefinition(job, input));
  if (duplicate) {
    await enqueueJob(duplicate.id, duplicate.nextRunAt);
    return duplicate;
  }

  const job: ScheduledJob = {
    id: crypto.randomUUID(),
    userId: input.userId,
    type: input.type,
    cron: input.cron,
    runAt: input.runAt,
    nextRunAt: input.nextRunAt,
    timezone: input.timezone,
    payload: input.payload ?? {},
    enabled: true,
    lastRunAt: null,
    lastError: null,
    lastResult: null,
  };

  const { data, error } = await getSupabase()
    .from("scheduled_jobs")
    .insert(toRow(job))
    .select("*")
    .single();

  if (error) {
    throw new Error(`创建定时任务失败: ${error.message}`);
  }

  await enqueueJob(job.id, job.nextRunAt);
  return toJob(data as ScheduledJobRow);
}

export async function listScheduledJobs(userId: string): Promise<ScheduledJob[]> {
  const { data, error } = await getSupabase()
    .from("scheduled_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`读取定时任务失败: ${error.message}`);
  }

  return ((data ?? []) as ScheduledJobRow[]).map(toJob);
}

export async function loadScheduledJob(id: string): Promise<ScheduledJob | null> {
  const { data, error } = await getSupabase()
    .from("scheduled_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`读取定时任务失败: ${error.message}`);
  }

  return data ? toJob(data as ScheduledJobRow) : null;
}

export async function deleteScheduledJob(input: {
  id: string;
  userId?: string;
}): Promise<void> {
  let query = getSupabase().from("scheduled_jobs").delete().eq("id", input.id);
  if (input.userId) query = query.eq("user_id", input.userId);

  const { error } = await query;
  if (error) {
    throw new Error(`删除定时任务失败: ${error.message}`);
  }

  await removeJobFromQueue(input.id);
}

export async function updateScheduledJob(input: {
  id: string;
  userId: string;
  type: ScheduledJobType;
  cron: string | null;
  runAt: number | null;
  nextRunAt: number;
  timezone: string;
  payload: ScheduledJobPayload;
  enabled: boolean;
}): Promise<ScheduledJob> {
  const { data, error } = await getSupabase()
    .from("scheduled_jobs")
    .update({
      type: input.type,
      cron: input.cron,
      run_at: input.runAt,
      next_run_at: input.nextRunAt,
      timezone: input.timezone,
      payload: input.payload,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("user_id", input.userId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`更新定时任务失败: ${error.message}`);
  }

  await removeJobFromQueue(input.id);
  if (input.enabled) {
    await enqueueJob(input.id, input.nextRunAt);
  }

  return toJob(data as ScheduledJobRow);
}

export async function markJobSuccess(input: {
  job: ScheduledJob;
  text?: string;
  nextRunAt?: number | null;
}): Promise<void> {
  const updates: Record<string, unknown> = {
    last_run_at: Date.now(),
    last_error: null,
    last_result: input.text?.slice(0, 4000) ?? null,
    updated_at: new Date().toISOString(),
  };

  if (typeof input.nextRunAt === "number") {
    updates.next_run_at = input.nextRunAt;
  } else if (input.nextRunAt === null) {
    updates.enabled = false;
  }

  const { error } = await getSupabase()
    .from("scheduled_jobs")
    .update(updates)
    .eq("id", input.job.id);

  if (error) {
    throw new Error(`更新定时任务状态失败: ${error.message}`);
  }
}

export async function markJobFailure(job: ScheduledJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { error: updateError } = await getSupabase()
    .from("scheduled_jobs")
    .update({
      last_run_at: Date.now(),
      last_error: message.slice(0, 4000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  if (updateError) {
    throw new Error(`记录定时任务失败状态失败: ${updateError.message}`);
  }
}

export async function recordJobRun(input: {
  job: ScheduledJob;
  status: ScheduledJobRunStatus;
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await getSupabase().from("scheduled_job_runs").insert({
    job_id: input.job.id,
    user_id: input.job.userId,
    status: input.status,
    result: input.result?.slice(0, 4000) ?? null,
    error: input.error?.slice(0, 4000) ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.error("[scheduler] 记录执行日志失败:", error.message);
  }
}
