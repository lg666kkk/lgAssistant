export type ScheduledJobType = "reminder" | "leetcode-daily" | "agent-task";

export type NotificationProvider = "telegram" | "wecom";
export type ScheduledOutputChannel = "inapp" | NotificationProvider;

export type ScheduledJobPayload = {
  name?: string;
  modelId?: string;
  text?: string;
  prompt?: string;
  channels?: ScheduledOutputChannel[];
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
  leaseOwner?: string | null;
  leaseUntil?: number | null;
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
  lease_owner?: string | null;
  lease_until?: number | null;
};

export type ScheduledJobRunStatus = "running" | "success" | "failed" | "skipped";

export type ScheduledJobRun = {
  id: number;
  jobId: string;
  userId: string;
  status: ScheduledJobRunStatus;
  result: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  scheduledFor: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type ScheduledDeliveryStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "retry_wait"
  | "dead";

export type ScheduledDelivery = {
  id: string;
  runId: number;
  jobId: string;
  userId: string;
  provider: NotificationProvider;
  status: ScheduledDeliveryStatus;
  text: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: number;
  providerMessageId: string | null;
  lastError: string | null;
};

export type ScheduledJobHandlerResult = {
  text?: string;
  metadata?: Record<string, unknown>;
};

export type ScheduledJobHandler = (
  job: ScheduledJob,
) => Promise<ScheduledJobHandlerResult | void>;
