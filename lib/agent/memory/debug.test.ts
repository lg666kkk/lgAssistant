import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryDebugEvent,
  createMemoryDebugReporter,
  isMemoryDebugEnabled,
} from "./debug";

const originalDebugFlag = process.env.MEMORY_DEBUG_LOGS;

afterEach(() => {
  if (originalDebugFlag === undefined) delete process.env.MEMORY_DEBUG_LOGS;
  else process.env.MEMORY_DEBUG_LOGS = originalDebugFlag;
  vi.restoreAllMocks();
});

describe("memory debug diagnostics", () => {
  it("is opt-in and only enables on the explicit true value", () => {
    delete process.env.MEMORY_DEBUG_LOGS;
    expect(isMemoryDebugEnabled()).toBe(false);

    process.env.MEMORY_DEBUG_LOGS = "1";
    expect(isMemoryDebugEnabled()).toBe(false);

    process.env.MEMORY_DEBUG_LOGS = "true";
    expect(isMemoryDebugEnabled()).toBe(true);
  });

  it("redacts sensitive content and removes user identifiers from SSE data", () => {
    const event = createMemoryDebugEvent({
      requestId: "request-123",
      sessionId: "session-456",
      now: new Date("2026-08-05T10:00:00.000Z"),
      entry: {
        phase: "extraction.completed",
        status: "completed",
        details: {
          userId: "must-not-reach-browser",
          nested: {
            user_id: "also-hidden",
            email: "person@example.com",
            phone: "13800138000",
            secret: "token_abcdefghijklmnop",
          },
        },
      },
    });

    expect(event).toMatchObject({
      requestId: "request-123",
      sessionId: "session-456",
      timestamp: "2026-08-05T10:00:00.000Z",
      phase: "extraction.completed",
      status: "completed",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("must-not-reach-browser");
    expect(serialized).not.toContain("also-hidden");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("13800138000");
    expect(serialized).not.toContain("token_abcdefghijklmnop");
    expect(serialized).toContain("[REDACTED_EMAIL]");
    expect(serialized).toContain("[REDACTED_PHONE]");
    expect(serialized).toContain("[REDACTED_SECRET]");
  });

  it("does not let a broken debug callback interrupt memory work", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const report = createMemoryDebugReporter(() => {
      throw new Error("console transport failed");
    });

    expect(() => report({ phase: "write.started", status: "started" })).not.toThrow();
  });
});
