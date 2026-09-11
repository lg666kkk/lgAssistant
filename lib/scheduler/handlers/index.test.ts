import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledJob } from "@/lib/scheduler/types";

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  resolveUserLlmModel: vi.fn(),
  listForModel: vi.fn(),
}));

vi.mock("@/lib/agent/runtime", () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock("@/lib/llm/config-service", () => ({
  resolveUserLlmModel: mocks.resolveUserLlmModel,
}));
vi.mock("@/lib/agent/tools/builtin", () => ({
  createBuiltinToolRegistry: () => ({ listForModel: mocks.listForModel }),
}));

import { runScheduledJobHandler } from "./index";

const job: ScheduledJob = {
  id: "job-1",
  userId: "user-1",
  type: "agent-task",
  cron: "0 9 * * *",
  runAt: null,
  nextRunAt: Date.now() + 60_000,
  timezone: "Asia/Shanghai",
  payload: { prompt: "生成日报", modelId: "model-record-1", channels: ["inapp"] },
  enabled: true,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listForModel.mockReturnValue([]);
  mocks.resolveUserLlmModel.mockResolvedValue({
    id: "model-record-1",
    displayName: "DeepSeek V4",
    supportsTools: true,
  });
  mocks.runAgentLoop.mockResolvedValue({
    loopMessages: [{ role: "assistant", content: "日报内容" }],
    completed: true,
    stopReason: "completed",
  });
});

describe("scheduled agent handler", () => {
  it.each(["max_iterations", "token_budget_exceeded", "awaiting_tool_confirmation", "awaiting_user_input", "aborted"])("rejects an unfinished run: %s", async (stopReason) => {
    mocks.runAgentLoop.mockResolvedValue({
      completed: stopReason.startsWith("awaiting"),
      stopReason,
      loopMessages: [{ role: "assistant", content: "尚未完成" }],
    });
    await expect(runScheduledJobHandler(job)).rejects.toThrow("未完成");
  });

  it("rejects a completed run without an answer", async () => {
    mocks.runAgentLoop.mockResolvedValue({ completed: true, stopReason: "completed", loopMessages: [] });
    await expect(runScheduledJobHandler(job)).rejects.toThrow("未完成");
  });
  it("resolves and executes the model selected by the task", async () => {
    const result = await runScheduledJobHandler(job);

    expect(mocks.resolveUserLlmModel).toHaveBeenCalledWith("user-1", "model-record-1");
    expect(mocks.runAgentLoop.mock.calls[0][11]).toBe("model-record-1");
    expect(result).toEqual({
      text: "日报内容",
      metadata: {
        stopReason: "completed",
        modelId: "model-record-1",
        modelName: "DeepSeek V4",
      },
    });
  });
});
