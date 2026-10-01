import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledJob } from "./types";

const mocks = vi.hoisted(() => ({
  claimDueJobs: vi.fn(),
  renewJobLease: vi.fn(),
  releaseJobLease: vi.fn(),
  startJobRun: vi.fn(),
  finalizeJobRun: vi.fn(),
  markJobFailure: vi.fn(),
  runScheduledJobHandler: vi.fn(),
  deliverDueNotifications: vi.fn(),
  nextRunTime: vi.fn(),
}));

vi.mock("./store", () => ({
  claimDueJobs: mocks.claimDueJobs,
  renewJobLease: mocks.renewJobLease,
  releaseJobLease: mocks.releaseJobLease,
  startJobRun: mocks.startJobRun,
  finalizeJobRun: mocks.finalizeJobRun,
  markJobFailure: mocks.markJobFailure,
}));
vi.mock("./handlers", () => ({ runScheduledJobHandler: mocks.runScheduledJobHandler }));
vi.mock("./deliveries", () => ({
  deliverDueNotifications: mocks.deliverDueNotifications,
}));
vi.mock("./cron", () => ({ nextRunTime: mocks.nextRunTime }));

import { tick } from "./tick";

const job: ScheduledJob = {
  id: "job-1",
  userId: "user-1",
  type: "agent-task",
  cron: "0 9 * * *",
  runAt: null,
  nextRunAt: 1_000,
  timezone: "Asia/Shanghai",
  payload: { prompt: "生成日报", channels: ["telegram"] },
  enabled: true,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claimDueJobs.mockResolvedValue([]).mockResolvedValueOnce([job]);
  mocks.renewJobLease.mockResolvedValue(true);
  mocks.startJobRun.mockResolvedValue(7);
  mocks.finalizeJobRun.mockResolvedValue(undefined);
  mocks.markJobFailure.mockResolvedValue(undefined);
  mocks.runScheduledJobHandler.mockResolvedValue({ text: "日报内容" });
  mocks.deliverDueNotifications.mockResolvedValue({ due: 1, delivered: 1, failed: 0, dead: 0 });
  mocks.nextRunTime.mockReturnValue(86_401_000);
});

describe("scheduler tick", () => {
  it("claims, runs, records and delivers a recurring job", async () => {
    const result = await tick(1_000, "worker-1");
    expect(mocks.claimDueJobs).toHaveBeenCalledWith({ now: 1_000, workerId: "worker-1", limit: 1 });
    expect(mocks.finalizeJobRun).toHaveBeenCalledWith({
      runId: 7,
      job,
      workerId: "worker-1",
      status: "success",
      result: "日报内容",
      metadata: { trigger: "schedule" },
      providers: ["telegram"],
      nextRunAt: 86_401_000,
      disable: false,
    });
    expect(result).toMatchObject({ executed: 1, failed: 0 });
  });

  it("does not rerun the agent when message delivery fails", async () => {
    mocks.deliverDueNotifications.mockResolvedValue({ due: 1, delivered: 0, failed: 1, dead: 0 });
    const result = await tick(1_000, "worker-1");
    expect(result).toMatchObject({ executed: 1, failed: 0 });
    expect(result.deliveries).toMatchObject({ failed: 1 });
    expect(mocks.markJobFailure).not.toHaveBeenCalled();
  });

  it("records execution failures and skips delivery creation", async () => {
    mocks.runScheduledJobHandler.mockRejectedValue(new Error("model unavailable"));
    const result = await tick(1_000, "worker-1");
    expect(result.failed).toBe(1);
    expect(mocks.markJobFailure).not.toHaveBeenCalled();
    expect(mocks.finalizeJobRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 7,
      status: "failed",
      error: "model unavailable",
      providers: [],
    }));
  });

  it("releases the leased job when a run record cannot be created", async () => {
    mocks.startJobRun.mockRejectedValue(new Error("run table unavailable"));
    const result = await tick(1_000, "worker-1");
    expect(result.failed).toBe(1);
    expect(mocks.markJobFailure).toHaveBeenCalledWith(expect.objectContaining({
      job,
      workerId: "worker-1",
    }));
    expect(mocks.finalizeJobRun).not.toHaveBeenCalled();
  });

  it("skips a stale recurring occurrence and schedules the next future run", async () => {
    const now = 20 * 60 * 1000;
    mocks.nextRunTime.mockReturnValue(now + 86_400_000);
    const result = await tick(now, "worker-1");

    expect(mocks.runScheduledJobHandler).not.toHaveBeenCalled();
    expect(mocks.finalizeJobRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 7,
      job,
      workerId: "worker-1",
      status: "skipped",
      providers: [],
      nextRunAt: now + 86_400_000,
      disable: false,
      metadata: expect.objectContaining({ reason: "recurring_misfire" }),
    }));
    expect(result).toMatchObject({ executed: 0, failed: 0, skipped: 1 });
  });

  it("runs manually without changing the recurring schedule", async () => {
    const { executeClaimedScheduledJob } = await import("./tick");
    const status = await executeClaimedScheduledJob({
      job,
      workerId: "manual-1",
      now: 5_000,
      trigger: "manual",
    });

    expect(status).toBe("success");
    expect(mocks.nextRunTime).not.toHaveBeenCalled();
    expect(mocks.finalizeJobRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 7,
      job,
      workerId: "manual-1",
      status: "success",
      nextRunAt: job.nextRunAt,
      disable: false,
      metadata: { trigger: "manual" },
    }));
  });

  it("disables an overdue one-time job after a successful manual run", async () => {
    const { executeClaimedScheduledJob } = await import("./tick");
    const oneTimeJob = { ...job, cron: null, runAt: 1_000, nextRunAt: 1_000 };
    await executeClaimedScheduledJob({
      job: oneTimeJob,
      workerId: "manual-1",
      now: 2_000,
      trigger: "manual",
    });

    expect(mocks.finalizeJobRun).toHaveBeenCalledWith(expect.objectContaining({
      job: oneTimeJob,
      nextRunAt: 1_000,
      disable: true,
    }));
  });
});

describe("scheduler lease ownership", () => {
  it("claims the next job only after the current job finishes", async () => {
    const order: string[] = [];
    mocks.claimDueJobs.mockReset().mockImplementationOnce(async () => { order.push("claim-1"); return [job]; })
      .mockImplementationOnce(async () => { order.push("claim-2"); return []; });
    mocks.runScheduledJobHandler.mockImplementation(async () => { order.push("execute"); return { text: "ok" }; });
    await tick(1_000, "worker-1");
    expect(order).toEqual(["claim-1", "execute", "claim-2"]);
  });
  it("does not execute or finalize a job after losing its lease", async () => {
    mocks.renewJobLease.mockResolvedValue(false);
    expect((await tick(1_000, "worker-1")).failed).toBe(1);
    expect(mocks.runScheduledJobHandler).not.toHaveBeenCalled();
    expect(mocks.finalizeJobRun).not.toHaveBeenCalled();
  });
  it("renews long agent tasks and forwards cancellation on lease loss", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mocks.renewJobLease.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.runScheduledJobHandler.mockImplementation(async (_job, inputSignal: AbortSignal) => {
      signal = inputSignal;
      return new Promise((_resolve, reject) => inputSignal.addEventListener("abort", () => reject(inputSignal.reason), { once: true }));
    });
    try {
      const result = tick(1_000, "worker-1");
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).failed).toBe(1);
      expect(signal?.aborted).toBe(true);
      expect(mocks.finalizeJobRun).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
