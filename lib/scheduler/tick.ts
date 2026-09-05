import { nextRunTime } from "@/lib/scheduler/cron";
import { runScheduledJobHandler } from "@/lib/scheduler/handlers";
import {
  claimDueJobs,
  finalizeJobRun,
  markJobFailure,
  releaseJobLease,
  startJobRun,
} from "@/lib/scheduler/store";
import { deliverDueNotifications, type DeliveryTickResult } from "@/lib/scheduler/deliveries";
import type { NotificationProvider } from "@/lib/scheduler/types";

export const RECURRING_MISFIRE_GRACE_MS = 10 * 60 * 1000;
export type ScheduledRunTrigger = "schedule" | "manual";

export type SchedulerTickResult = {
  now: number;
  due: number;
  executed: number;
  failed: number;
  skipped: number;
  deliveries: DeliveryTickResult;
};

function notificationProviders(value: unknown): NotificationProvider[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(
    (provider): provider is NotificationProvider =>
      provider === "telegram" || provider === "wecom",
  )));
}

function isRecurringMisfire(job: { cron: string | null; nextRunAt: number }, now: number) {
  return Boolean(job.cron) && now - job.nextRunAt > RECURRING_MISFIRE_GRACE_MS;
}

export async function tick(now = Date.now(), workerId = `scheduler-${crypto.randomUUID()}`): Promise<SchedulerTickResult> {
  const jobs = await claimDueJobs({ now, workerId });
  const result: SchedulerTickResult = {
    now,
    due: jobs.length,
    executed: 0,
    failed: 0,
    skipped: 0,
    deliveries: { due: 0, delivered: 0, failed: 0, dead: 0 },
  };

  for (const job of jobs) {
    if (!job.enabled) {
      result.skipped += 1;
      continue;
    }

    const status = await executeClaimedScheduledJob({ job, workerId, now, trigger: "schedule" });
    result[status === "success" ? "executed" : status === "failed" ? "failed" : "skipped"] += 1;
  }

  result.deliveries = await deliverDueNotifications({ workerId, now });

  return result;
}

export async function executeClaimedScheduledJob(input: {
  job: Awaited<ReturnType<typeof claimDueJobs>>[number];
  workerId: string;
  now?: number;
  trigger: ScheduledRunTrigger;
}): Promise<"success" | "failed" | "skipped"> {
  const { job, workerId, trigger } = input;
  const now = input.now ?? Date.now();
  let runId: number;
  try {
    runId = await startJobRun({
      job,
      workerId,
      scheduledFor: trigger === "manual" ? now : job.nextRunAt,
    });
  } catch (error) {
    if (trigger === "schedule") {
      await markJobFailure({ job, error, retryAt: Date.now() + 5 * 60 * 1000, workerId });
    } else {
      await releaseJobLease({ job, workerId });
    }
    return "failed";
  }

  if (trigger === "schedule" && isRecurringMisfire(job, now)) {
    const nextRunAt = nextRunTime(job.cron!, {
      timezone: job.timezone,
      currentDate: now,
    });
    await finalizeJobRun({
      runId,
      job,
      workerId,
      status: "skipped",
      result: "周期任务错过执行窗口，已自动重新排期。",
      metadata: {
        trigger,
        reason: "recurring_misfire",
        latenessMs: now - job.nextRunAt,
      },
      providers: [],
      nextRunAt,
      disable: false,
    });
    return "skipped";
  }

  try {
    const handlerResult = await runScheduledJobHandler(job);
    let nextRunAt: number | null = job.nextRunAt;
    let disable = trigger === "manual" && !job.cron && job.nextRunAt <= now;
    if (trigger === "schedule") {
      nextRunAt = job.cron
        ? nextRunTime(job.cron, {
          timezone: job.timezone,
          currentDate: Math.max(now, Date.now()),
        })
        : null;
      disable = !job.cron;
    }

    await finalizeJobRun({
      runId,
      job,
      workerId,
      status: "success",
      result: handlerResult.text,
      metadata: { ...handlerResult.metadata, trigger },
      providers: notificationProviders(job.payload.channels),
      nextRunAt,
      disable,
    });
    return "success";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeJobRun({
      runId,
      job,
      workerId,
      status: "failed",
      error: message,
      metadata: { trigger },
      providers: [],
      nextRunAt: trigger === "schedule" ? Date.now() + 5 * 60 * 1000 : job.nextRunAt,
      disable: false,
    });
    return "failed";
  }
}
