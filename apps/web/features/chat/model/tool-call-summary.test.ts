import { describe, expect, it } from "vitest";
import { summarizeToolCalls } from "./tool-call-summary";

describe("summarizeToolCalls", () => {
  it("separates model requests from actual executions and budget skips", () => {
    expect(summarizeToolCalls([
      { metadata: {} },
      { metadata: { status: "retrieval_budget_skipped" } },
      { metadata: {} },
      { metadata: {} },
    ])).toEqual({
      requestedCount: 4,
      executedCount: 3,
      skippedCount: 1,
      waitingCount: 0,
      blockedCount: 0,
    });
  });

  it("does not count pending or blocked tool requests as executions", () => {
    expect(summarizeToolCalls([
      { metadata: { status: "pending_confirmation" } },
      { metadata: { status: "orchestration_prerequisite_missing" } },
      { metadata: { status: "failed" } },
    ])).toMatchObject({
      requestedCount: 3,
      executedCount: 1,
      waitingCount: 1,
      blockedCount: 1,
    });
  });
});
