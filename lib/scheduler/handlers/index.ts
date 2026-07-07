import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { runAgentLoop } from "@/lib/agent/runtime";
import { defaultChatModel } from "@/lib/agent/models";
import {
  formatDailyLeetCodePractice,
  getDailyLeetCodePractice,
} from "@/lib/leetcode/daily-practice";
import type {
  ScheduledJob,
  ScheduledJobHandler,
  ScheduledJobHandlerResult,
  ScheduledJobType,
} from "@/lib/scheduler/types";

async function postWebhook(job: ScheduledJob, text: string): Promise<void> {
  if (job.payload.channel !== "webhook" || typeof job.payload.webhookUrl !== "string") {
    return;
  }

  const response = await fetch(job.payload.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId: job.id,
      type: job.type,
      userId: job.userId,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Webhook 推送失败: ${response.status}`);
  }
}

const reminder: ScheduledJobHandler = async (job) => {
  const text = typeof job.payload.text === "string" ? job.payload.text : "提醒时间到了";
  await postWebhook(job, text);
  return { text };
};

const leetcodeDaily: ScheduledJobHandler = async (job) => {
  const practice = await getDailyLeetCodePractice({
    timeZone: job.timezone,
    userId: job.userId,
  });
  const text = formatDailyLeetCodePractice(practice);
  await postWebhook(job, text);
  return {
    text,
    metadata: {
      date: practice.date,
      roundNo: practice.roundNo,
      problemIds: practice.problems.map((problem) => problem.id),
    },
  };
};

function extractLastAssistantText(messages: any[]): string {
  return [...messages].reverse().reduce((found, message) => {
    if (found || message.role !== "assistant") return found;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
    }
    return found;
  }, "");
}

const agentTask: ScheduledJobHandler = async (job) => {
  if (typeof job.payload.prompt !== "string" || !job.payload.prompt.trim()) {
    throw new Error("agent-task 需要 payload.prompt");
  }

  const toolRegistry = createBuiltinToolRegistry();
  const tools = toolRegistry.listForModel();
  const result = await runAgentLoop(
    [{ role: "user", content: job.payload.prompt }],
    tools,
    toolRegistry,
    6,
    [],
    () => true,
    `scheduled-${job.id}-${Date.now()}`,
    `scheduled:${job.id}`,
    undefined,
    `你正在执行一个定时任务。当前时间：${new Date().toISOString()}。`,
    () => false,
    defaultChatModel,
    undefined,
    job.userId,
  );

  const text = extractLastAssistantText(result.loopMessages) || "Agent 定时任务已执行完成。";
  await postWebhook(job, text);
  return { text, metadata: { stopReason: result.stopReason } };
};

export const scheduledJobHandlers: Record<ScheduledJobType, ScheduledJobHandler> = {
  reminder,
  "leetcode-daily": leetcodeDaily,
  "agent-task": agentTask,
};

export async function runScheduledJobHandler(
  job: ScheduledJob,
): Promise<ScheduledJobHandlerResult> {
  const handler = scheduledJobHandlers[job.type];
  if (!handler) {
    throw new Error(`未知定时任务类型: ${job.type}`);
  }

  return (await handler(job)) ?? {};
}
