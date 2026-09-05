import { getSupabase } from "@/lib/platform/supabase";
import type {
  ScheduledJob,
  ScheduledJobPayload,
  ScheduledJobRow,
  ScheduledJobRun,
  ScheduledJobType,
} from "@/lib/scheduler/types";

type ScheduledJobRunRow = {
  id: number;
  job_id: string;
  user_id: string;
  status: ScheduledJobRun["status"];
  result: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  scheduled_for: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

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
    enabled?: boolean;
  },
) {
  return (
    job.enabled === (input.enabled ?? true) &&
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
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until ?? null,
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
    lease_owner: job.leaseOwner ?? null,
    lease_until: job.leaseUntil ?? null,
  };
}

export async function claimDueJobs(input: {
  now?: number;
  workerId: string;
  leaseMs?: number;
  limit?: number;
}): Promise<ScheduledJob[]> {
  const { data, error } = await getSupabase().rpc("claim_due_scheduled_jobs", {
    p_now: input.now ?? Date.now(),
    p_worker_id: input.workerId,
    p_lease_ms: input.leaseMs ?? 5 * 60 * 1000,
    p_limit: input.limit ?? 10,
  });
  if (error) {
    const migrationHint = error.code === "PGRST202" || error.code === "42883"
      ? "，请先执行 20260904-reliable-scheduler-channels.sql"
      : "";
    throw new Error(`领取定时任务失败: ${error.message}${migrationHint}`);
  }
  return ((data ?? []) as ScheduledJobRow[]).map(toJob);
}

export async function claimScheduledJobNow(input: {
  jobId: string;
  userId: string;
  now?: number;
  workerId: string;
  leaseMs?: number;
}): Promise<ScheduledJob | null> {
  const { data, error } = await getSupabase().rpc("claim_scheduled_job_now", {
    p_job_id: input.jobId,
    p_user_id: input.userId,
    p_now: input.now ?? Date.now(),
    p_worker_id: input.workerId,
    p_lease_ms: input.leaseMs ?? 5 * 60 * 1000,
  });
  if (error) throw new Error(`领取立即运行任务失败: ${error.message}`);
  const row = ((data ?? []) as ScheduledJobRow[])[0];
  return row ? toJob(row) : null;
}

export async function createScheduledJob(input: {
  userId: string;
  type: ScheduledJobType;
  cron: string | null;
  runAt: number | null;
  nextRunAt: number;
  timezone: string;
  payload?: ScheduledJobPayload;
  enabled?: boolean;
}): Promise<ScheduledJob> {
  const existingJobs = await listScheduledJobs(input.userId);
  const duplicate = existingJobs.find((job) => sameJobDefinition(job, input));
  if (duplicate) {
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
    enabled: input.enabled ?? true,
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

export async function listRecentJobRuns(
  userId: string,
  limit = 30,
  jobId?: string,
): Promise<ScheduledJobRun[]> {
  let query = getSupabase()
    .from("scheduled_job_runs")
    .select("id,job_id,user_id,status,result,error,metadata,scheduled_for,started_at,finished_at,created_at")
    .eq("user_id", userId);
  if (jobId) query = query.eq("job_id", jobId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(`读取定时任务运行记录失败: ${error.message}`);
  return ((data ?? []) as ScheduledJobRunRow[]).map((row) => ({
    id: Number(row.id),
    jobId: row.job_id,
    userId: row.user_id,
    status: row.status,
    result: row.result,
    error: row.error,
    metadata: row.metadata ?? {},
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  }));
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
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("user_id", input.userId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`更新定时任务失败: ${error.message}`);
  }

  return toJob(data as ScheduledJobRow);
}

export async function markJobFailure(input: {
  job: ScheduledJob;
  error: unknown;
  retryAt: number;
  workerId: string;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const { data, error: updateError } = await getSupabase()
    .from("scheduled_jobs")
    .update({
      last_run_at: Date.now(),
      last_error: message.slice(0, 4000),
      next_run_at: input.retryAt,
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.job.id)
    .eq("lease_owner", input.workerId)
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(`记录定时任务失败状态失败: ${updateError.message}`);
  }
  if (!data) throw new Error("记录定时任务失败状态失败: 任务租约已失效");
}

export async function releaseJobLease(input: {
  job: ScheduledJob;
  workerId: string;
}): Promise<void> {
  const { error } = await getSupabase()
    .from("scheduled_jobs")
    .update({
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.job.id)
    .eq("lease_owner", input.workerId);
  if (error) throw new Error(`释放定时任务租约失败: ${error.message}`);
}

export async function startJobRun(input: {
  job: ScheduledJob;
  workerId: string;
  scheduledFor: number;
}): Promise<number> {
  const { data, error } = await getSupabase().from("scheduled_job_runs").insert({
    job_id: input.job.id,
    user_id: input.job.userId,
    status: "running",
    scheduled_for: input.scheduledFor,
    started_at: new Date().toISOString(),
    worker_id: input.workerId,
    metadata: {},
  }).select("id").single();
  if (error) throw new Error(`创建定时任务运行记录失败: ${error.message}`);
  return Number(data.id);
}

export async function finalizeJobRun(input: {
  runId: number;
  job: ScheduledJob;
  workerId: string;
  status: "success" | "failed" | "skipped";
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  providers?: Array<"telegram" | "wecom">;
  nextRunAt: number | null;
  disable: boolean;
  finishedAt?: number;
}) {
  const { error } = await getSupabase().rpc("finalize_scheduled_job_run", {
    p_run_id: input.runId,
    p_job_id: input.job.id,
    p_worker_id: input.workerId,
    p_status: input.status,
    p_result: input.result ?? null,
    p_error: input.error ?? null,
    p_metadata: input.metadata ?? {},
    p_providers: input.providers ?? [],
    p_next_run_at: input.nextRunAt,
    p_disable: input.disable,
    p_finished_at: input.finishedAt ?? Date.now(),
  });
  if (error) throw new Error(`原子完成定时任务失败: ${error.message}`);
}
