import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), model: vi.fn() }));
vi.mock("./store", () => ({ createScheduledJob: mocks.create }));
vi.mock("@/lib/llm/config-service", () => ({ resolveUserLlmModel: mocks.model }));
import { createValidatedScheduledJob } from "./create";
import { createScheduledJobTool } from "@/lib/agent/tools/scheduled-jobs";
const input = { userId: "u1", type: "agent-task" as const, cron: "0 9 * * *", payload: { prompt: "总结五条 AI 新闻" } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.model.mockResolvedValue({ id: "model1", supportsTools: true });
  mocks.create.mockImplementation(async (data) => ({ ...data, id: "job1" }));
});
describe("validated schedule creation", () => {
  it("resolves the user's model and default output for both creation paths", async () => {
    const job = await createValidatedScheduledJob(input);
    expect(job.payload).toMatchObject({ modelId: "model1", channels: ["inapp"] });
    expect(mocks.model).toHaveBeenCalledWith("u1", null);
  });
  it("rejects unsupported models before persisting", async () => {
    mocks.model.mockResolvedValue({ supportsTools: false });
    await expect(createValidatedScheduledJob(input)).rejects.toThrow("支持工具调用");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects ambiguous schedules, empty reminders and invalid timezones", async () => {
    await expect(createValidatedScheduledJob({ ...input, runAt: Date.now() + 60000 })).rejects.toThrow("二选一");
    await expect(createValidatedScheduledJob({ ...input, type: "reminder", payload: {} })).rejects.toThrow("提醒内容");
    await expect(createValidatedScheduledJob({ ...input, timezone: "invalid" })).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("creates through the conversational tool and returns a receipt", async () => {
    const result = await createScheduledJobTool.execute(input, { userId: "u1" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("job1");
    expect(createScheduledJobTool.runtime.requiresConfirmation).toBe(true);
  });
  it("rejects absolute dates without a timezone and unauthenticated calls", async () => {
    const result = await createScheduledJobTool.execute({ type: "reminder", runAt: "2030-01-01T09:00:00", payload: { text: "喝水" } }, { userId: "u1" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("时区");
    expect((await createScheduledJobTool.execute(input)).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
