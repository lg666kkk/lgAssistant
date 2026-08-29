import { describe, expect, it } from "vitest";
import { buildChatTraceInput } from "./observability";

describe("buildChatTraceInput", () => {
  it("uses the latest user message and bounded history previews", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}`,
    }));

    const result = buildChatTraceInput({
      requestId: "request-1",
      sessionId: "session-1",
      userId: "user-1",
      model: "model-1",
      messages,
    });

    expect(result.query).toBe("message-8");
    expect(result.historyPreview).toHaveLength(6);
    expect(result.historyPreview[0].preview).toBe("message-2");
  });
});
