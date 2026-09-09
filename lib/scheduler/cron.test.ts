import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUpdatedNextRunAt } from "./cron";

describe("scheduled job updates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing next run for an ordinary update to a disabled job", () => {
    expect(resolveUpdatedNextRunAt({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
      reschedule: false,
      existingNextRunAt: 123,
    })).toBe(123);
  });

  it("recalculates the next run when a disabled job is explicitly rescheduled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z"));

    expect(resolveUpdatedNextRunAt({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
      reschedule: true,
      existingNextRunAt: 123,
    })).toBe(new Date("2026-09-10T09:00:00.000Z").getTime());
  });
});
