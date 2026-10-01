import { resolveUserLlmModel } from "@/lib/llm/config-service";
import { validateSchedule } from "./cron";
import { createScheduledJob } from "./store";
import type { ScheduledJobPayload, ScheduledJobType } from "./types";
import { normalizeScheduledJobPayload } from "./validation";

export async function validateTaskModel(userId: string, type: ScheduledJobType, payload: ScheduledJobPayload) {
  if (type !== "agent-task") return;
  const modelId = typeof payload.modelId === "string" && payload.modelId.trim() ? payload.modelId.trim() : null;
  const model = await resolveUserLlmModel(userId, modelId);
  if (!model.supportsTools) throw new Error("定时 Agent 任务只能使用支持工具调用的模型");
  payload.modelId = model.id;
}

export async function createValidatedScheduledJob(input: {
  userId: string;
  type: ScheduledJobType;
  cron?: string | null;
  runAt?: number | null;
  timezone?: string;
  payload?: unknown;
  enabled?: boolean;
}) {
  if (!input.userId) throw new Error("创建定时任务需要先登录");
  if (!["reminder", "leetcode-daily", "agent-task"].includes(input.type)) throw new Error("未知任务类型");
  const timezone = input.timezone ?? "Asia/Shanghai";
  new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
  const cron = input.cron?.trim() || null;
  const runAt = input.runAt ?? null;
  if (cron && runAt !== null) throw new Error("cron 和 runAt 只能二选一");
  if (cron && cron.split(/\s+/).length !== 5) throw new Error("cron 必须是 5 段表达式");
  const nextRunAt = validateSchedule({ cron, runAt, timezone });
  const payload = normalizeScheduledJobPayload(input.type, input.payload ?? {});
  if (input.type === "reminder" && (typeof payload.text !== "string" || !payload.text.trim())) {
    throw new Error("提醒任务必须填写提醒内容");
  }
  if (input.enabled !== false) await validateTaskModel(input.userId, input.type, payload);
  return createScheduledJob({ ...input, cron, runAt, timezone, nextRunAt, payload });
}
