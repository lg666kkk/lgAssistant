import { describe, expect, it, vi } from "vitest";
import type { ChatApplicationDependencies } from "./ports";
import { runChatUseCase } from "./run-chat";

function fakeDependencies(): ChatApplicationDependencies {
  return {
    userContext: {
      resolveModel: vi.fn(),
      resolveMemoryConfig: vi.fn(),
      resolveUserProfile: vi.fn(),
      readKnowledgeProfile: vi.fn(),
    },
    sessions: {
      resolveLoopMessages: vi.fn(),
      persistTurn: vi.fn(),
      createSnapshot: vi.fn(),
      saveSnapshot: vi.fn(),
      updateSystemPrompt: vi.fn(),
    },
    traces: {
      save: vi.fn(),
      appendMemoryConsolidation: vi.fn(),
    },
    telemetry: {
      withTrace: vi.fn(),
    },
  };
}

describe("runChatUseCase dependency boundary", () => {
  it("handles invalid input without touching infrastructure adapters", async () => {
    const dependencies = fakeDependencies();
    const response = await runChatUseCase({
      request: new Request("http://localhost/api/chat", {
        method: "POST",
        body: "{invalid",
      }),
      userId: "user-1",
      dependencies,
    });

    expect(response.status).toBe(400);
    expect(dependencies.userContext.resolveModel).not.toHaveBeenCalled();
    expect(dependencies.sessions.resolveLoopMessages).not.toHaveBeenCalled();
    expect(dependencies.traces.save).not.toHaveBeenCalled();
    expect(dependencies.telemetry.withTrace).not.toHaveBeenCalled();
  });
});
