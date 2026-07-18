import { describe, expect, it } from "vitest";
import { nextIngestionFailureState } from "./ingestion-queue";

describe("RAG ingestion retry policy", () => {
  const now = new Date("2026-07-17T00:00:00.000Z");

  it("uses bounded exponential backoff before the DLQ", () => {
    expect(nextIngestionFailureState({ attempts: 1, maxAttempts: 3, now }))
      .toEqual({
        status: "retry_wait",
        nextAttemptAt: "2026-07-17T00:00:05.000Z",
        retentionUntil: undefined,
      });
    expect(nextIngestionFailureState({ attempts: 2, maxAttempts: 3, now }))
      .toMatchObject({
        status: "retry_wait",
        nextAttemptAt: "2026-07-17T00:00:10.000Z",
      });
  });

  it("moves the final failed attempt to the DLQ", () => {
    expect(nextIngestionFailureState({ attempts: 3, maxAttempts: 3, now }))
      .toEqual({
        status: "dead",
        nextAttemptAt: "2026-07-17T00:00:20.000Z",
        retentionUntil: "2026-10-15T00:00:00.000Z",
      });
  });
});
