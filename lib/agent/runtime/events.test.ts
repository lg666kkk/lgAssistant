import { describe, expect, it } from "vitest";
import { serializeEvent, type AgentEvent } from "./events";

describe("agent SSE events", () => {
  it("serializes memory debug events with their SSE event name", () => {
    const event: AgentEvent = {
      type: "memory_debug",
      memory: {
        requestId: "request-123",
        sessionId: "session-456",
        timestamp: "2026-08-05T10:00:00.000Z",
        phase: "write.completed",
        status: "completed",
        details: { action: "UPDATE", targetKey: "diet:favorite:cilantro" },
      },
    };

    const serialized = serializeEvent(event);
    expect(serialized).toContain("event:memory_debug\n");
    expect(serialized).toContain('"phase":"write.completed"');
    expect(serialized.endsWith("\n\n")).toBe(true);
  });
});
