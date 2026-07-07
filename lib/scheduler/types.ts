export type ScheduledJobType = "reminder" | "leetcode-daily" | "agent-task";

export type ScheduledJobPayload = {
  text?: string;
  prompt?: string;
  channel?: "webhook" | "inapp";
  webhookUrl?: string;
  timeZone?: string;
  [key: string]: unknown;
};

export type ScheduledJob = {
  id: string;
  userId: string;
  type: ScheduledJobType;
  cron: string | null;
  runAt: number | null;
  nextRunAt: number;
  timezone: string;
  payload: ScheduledJobPayload;
  enabled: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  lastResult: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ScheduledJobRow = {
  id: string;
  user_id: string;
  type: ScheduledJobType;
  cron: string | null;
  run_at: number | null;
  next_run_at: number;
  timezone: string | null;
  payload: ScheduledJobPayload | null;
  enabled: boolean | null;
  last_run_at: number | null;
  last_error: string | null;
  last_result: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ScheduledJobRunStatus = "success" | "failed" | "skipped";

export type ScheduledJobHandlerResult = {
  text?: string;
  metadata?: Record<string, unknown>;
};

export type ScheduledJobHandler = (
  job: ScheduledJob,
) => Promise<ScheduledJobHandlerResult | void>;
