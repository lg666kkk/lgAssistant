import { validateSchedule } from "@/lib/scheduler/cron";
import { createScheduledJob } from "@/lib/scheduler/store";
import type { ScheduledJobPayload, ScheduledJobType } from "@/lib/scheduler/types";
import {
  defaultToolRuntimePolicy,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./types";

type CreateScheduledJobInput = {
  type: ScheduledJobType;
  cron?: string;
  runAt?: string | number;
  timezone?: string;
  payload?: ScheduledJobPayload;
};

const JOB_TYPES = new Set<ScheduledJobType>([
  "reminder",
  "leetcode-daily",
  "agent-task",
]);

function parseRunAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

function parseInput(input: unknown): CreateScheduledJobInput {
  if (!input || typeof input !== "object") {
    throw new Error("参数必须是对象");
  }

  const data = input as Record<string, unknown>;
  const type = data.type as ScheduledJobType;
  if (!JOB_TYPES.has(type)) {
    throw new Error("type 必须是 reminder、leetcode-daily 或 agent-task");
  }

  const cron = typeof data.cron === "string" && data.cron.trim()
    ? data.cron.trim()
    : undefined;
  const runAt = typeof data.runAt === "string" || typeof data.runAt === "number"
    ? data.runAt
    : undefined;

  if (!cron && runAt === undefined) {
    throw new Error("必须提供 cron 或 runAt");
  }

  if (cron && runAt !== undefined) {
    throw new Error("cron 和 runAt 只能二选一");
  }

  if (data.timezone !== undefined && typeof data.timezone !== "string") {
    throw new Error("timezone 必须是字符串");
  }

  if (data.payload !== undefined && (typeof data.payload !== "object" || data.payload === null)) {
    throw new Error("payload 必须是对象");
  }

  return {
    type,
    cron,
    runAt,
    timezone: typeof data.timezone === "string" ? data.timezone : "Asia/Shanghai",
    payload: (data.payload ?? {}) as ScheduledJobPayload,
  };
}

function describeSchedule(input: {
  cron?: string;
  runAt: number | null;
  timezone: string;
  nextRunAt: number;
}) {
  if (input.cron) {
    return `cron=${input.cron}，时区=${input.timezone}，下次执行=${new Date(input.nextRunAt).toISOString()}`;
  }

  return `执行时间=${new Date(input.runAt ?? input.nextRunAt).toISOString()}，时区=${input.timezone}`;
}

export const createScheduledJobTool: ToolDefinition = {
  name: "create_scheduled_job",
  description:
    "创建一个定时任务。适合用户要求定时提醒、每天/每周周期执行、定时生成 LeetCode 练习、或让 Agent 在指定时间执行一段 prompt 时使用。相对时间要先结合当前时间换算成 ISO 时间；周期任务使用 5 段 cron 表达式，并通过 timezone 表示用户时区。",
  runtime: {
    ...defaultToolRuntimePolicy,
    requiresAuth: true,
    sideEffect: "write",
    requiresConfirmation: true,
    concurrencyGroup: "scheduler",
    maxConcurrency: 1,
  },
  riskLevel: "confirm",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["reminder", "leetcode-daily", "agent-task"],
        description:
          "任务类型：reminder=到点记录/通知提醒；leetcode-daily=生成每日 LeetCode 热题练习；agent-task=到点执行一段 Agent prompt",
      },
      runAt: {
        type: "string",
        description:
          "一次性任务执行时间，使用 ISO 8601，例如 2026-07-05T21:30:00+08:00。和 cron 二选一。",
      },
      cron: {
        type: "string",
        description:
          "周期任务 cron 表达式，5 段格式，例如每天北京时间 9 点是 0 9 * * *。和 runAt 二选一。",
      },
      timezone: {
        type: "string",
        description: "用户时区，默认 Asia/Shanghai",
      },
      payload: {
        type: "object",
        description:
          "任务参数。reminder 用 { text }；agent-task 用 { prompt }；可选 { channel:'webhook', webhookUrl } 接收结果。",
      },
    },
    required: ["type"],
    additionalProperties: false,
  },
  execute: async (
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> => {
    if (!context?.userId) {
      return {
        ok: false,
        content: "创建定时任务需要先登录。",
        error: "Missing userId",
      };
    }

    try {
      const parsed = parseInput(input);
      const runAt = parseRunAt(parsed.runAt);
      const cron = parsed.cron ?? null;
      const nextRunAt = validateSchedule({
        cron,
        runAt,
        timezone: parsed.timezone,
      });
      const job = await createScheduledJob({
        userId: context.userId,
        type: parsed.type,
        cron,
        runAt: cron ? null : runAt,
        nextRunAt,
        timezone: parsed.timezone ?? "Asia/Shanghai",
        payload: parsed.payload,
      });

      return {
        ok: true,
        content: [
          "定时任务已创建。",
          `任务 ID：${job.id}`,
          `类型：${job.type}`,
          describeSchedule({
            cron: job.cron ?? undefined,
            runAt: job.runAt,
            timezone: job.timezone,
            nextRunAt: job.nextRunAt,
          }),
        ].join("\n"),
        data: job,
      };
    } catch (error) {
      return {
        ok: false,
        content:
          "创建定时任务失败，请确认 scheduled_jobs / scheduled_job_runs 表已创建，并检查时间参数。",
        error: error instanceof Error ? error.message : "Create scheduled job failed",
      };
    }
  },
};
