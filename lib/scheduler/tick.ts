import { nextRunTime } from "@/lib/scheduler/cron";
import { runScheduledJobHandler } from "@/lib/scheduler/handlers";
import {
  claimDueJobs,
  renewJobLease,
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
  const result: SchedulerTickResult = {
    now, due: 0, executed: 0, failed: 0, skipped: 0,
    deliveries: { due: 0, delivered: 0, failed: 0, dead: 0 },
  };
  // Do not reserve jobs whose lease would expire while waiting behind a slow agent.
  for (let index = 0; index < 10; index++) {
    const [job] = await claimDueJobs({ now: index === 0 ? now : Date.now(), workerId, limit: 1 });
    if (!job) break;
    result.due += 1;
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

  let leaseLost = false;
  try {
    const controller = new AbortController();
    const renew = async () => {
      try {
        if (!await renewJobLease({ job, workerId })) throw new Error("定时任务租约已失效");
      } catch (error) { leaseLost = true; controller.abort(error); }
    };
    await renew();
    controller.signal.throwIfAborted();
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renew().finally(() => { renewing = false; });
    }, 30_000);
    let handlerResult: Awaited<ReturnType<typeof runScheduledJobHandler>>;
    try {
      handlerResult = await runScheduledJobHandler(job, controller.signal);
      controller.signal.throwIfAborted();
      await renew();
      controller.signal.throwIfAborted();
    } finally { clearInterval(heartbeat); }
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
    if (leaseLost) return "failed"; // A new owner must be allowed to finish; never finalize its lease.
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
