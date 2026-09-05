import type {
  ScheduledOutputChannel,
  ScheduledJobPayload,
  ScheduledJobType,
} from "@/lib/scheduler/types";

const OUTPUT_CHANNELS = new Set<ScheduledOutputChannel>(["inapp", "telegram", "wecom"]);

export function normalizeScheduledJobPayload(
  type: ScheduledJobType,
  value: unknown,
): ScheduledJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务内容必须是对象");
  }
  const payload = { ...(value as Record<string, unknown>) } as ScheduledJobPayload;
  if (payload.name !== undefined && typeof payload.name !== "string") {
    throw new Error("任务名称必须是字符串");
  }
  if (typeof payload.name === "string" && payload.name.length > 100) {
    throw new Error("任务名称不能超过 100 个字符");
  }
  if (payload.modelId !== undefined && typeof payload.modelId !== "string") {
    throw new Error("任务模型 ID 必须是字符串");
  }
  if (typeof payload.modelId === "string" && payload.modelId.length > 100) {
    throw new Error("任务模型 ID 长度无效");
  }
  if (payload.channels !== undefined) {
    if (!Array.isArray(payload.channels) || payload.channels.some((item) => !OUTPUT_CHANNELS.has(item))) {
      throw new Error("输出方式只支持 inapp、telegram 或 wecom");
    }
    payload.channels = Array.from(new Set(["inapp" as const, ...payload.channels]));
  } else {
    payload.channels = ["inapp"];
  }
  if (type === "agent-task" && (typeof payload.prompt !== "string" || !payload.prompt.trim())) {
    throw new Error("Agent 定时任务必须填写执行内容");
  }
  if (type === "reminder" && payload.text !== undefined && typeof payload.text !== "string") {
    throw new Error("提醒内容必须是字符串");
  }
  return payload;
}
