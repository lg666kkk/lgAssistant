import { CronExpressionParser } from "cron-parser";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

export function nextRunTime(
  expression: string,
  options: {
    timezone?: string;
    currentDate?: Date | number;
  } = {},
): number {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: options.currentDate ? new Date(options.currentDate) : new Date(),
    tz: options.timezone ?? DEFAULT_TIMEZONE,
  });

  return interval.next().toDate().getTime();
}

export function validateSchedule(input: {
  cron?: string | null;
  runAt?: number | null;
  timezone?: string;
}): number {
  if (input.cron?.trim()) {
    return nextRunTime(input.cron.trim(), { timezone: input.timezone });
  }

  if (typeof input.runAt === "number" && Number.isFinite(input.runAt)) {
    if (input.runAt <= Date.now()) {
      throw new Error("runAt 必须是未来时间戳");
    }
    return input.runAt;
  }

  throw new Error("必须提供 cron 或 runAt");
}

export function resolveUpdatedNextRunAt(input: {
  cron?: string | null;
  runAt?: number | null;
  timezone?: string;
  enabled: boolean;
  reschedule: boolean;
  existingNextRunAt: number;
}): number {
  if (!input.enabled && !input.reschedule) {
    return input.existingNextRunAt;
  }

  return validateSchedule(input);
}
