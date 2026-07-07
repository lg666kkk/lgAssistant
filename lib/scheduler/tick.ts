import { nextRunTime } from "@/lib/scheduler/cron";
import { runScheduledJobHandler } from "@/lib/scheduler/handlers";
import {
  enqueueJob,
  loadScheduledJob,
  markJobFailure,
  markJobSuccess,
  popDueJobIds,
  recordJobRun,
} from "@/lib/scheduler/store";

export type SchedulerTickResult = {
  now: number;
  due: number;
  executed: number;
  failed: number;
  skipped: number;
};

export async function tick(now = Date.now()): Promise<SchedulerTickResult> {
  const ids = await popDueJobIds(now);
  const result: SchedulerTickResult = {
    now,
    due: ids.length,
    executed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const id of ids) {
    const job = await loadScheduledJob(id);
    if (!job || !job.enabled) {
      result.skipped += 1;
      continue;
    }

    try {
      const handlerResult = await runScheduledJobHandler(job);
      let nextRunAt: number | null = null;

      if (job.cron) {
        nextRunAt = nextRunTime(job.cron, {
          timezone: job.timezone,
          currentDate: Math.max(now, Date.now()),
        });
        await enqueueJob(job.id, nextRunAt);
      }

      await markJobSuccess({
        job,
        text: handlerResult.text,
        nextRunAt,
      });
      await recordJobRun({
        job,
        status: "success",
        result: handlerResult.text,
        metadata: handlerResult.metadata,
      });
      result.executed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markJobFailure(job, error);
      await recordJobRun({
        job,
        status: "failed",
        error: message,
      });
      result.failed += 1;

      if (job.cron) {
        const retryAt = Date.now() + 5 * 60 * 1000;
        await enqueueJob(job.id, retryAt);
      }
    }
  }

  return result;
}
