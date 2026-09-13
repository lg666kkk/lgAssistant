import { describe, expect, it, vi } from "vitest";
import type { ChatApplicationDependencies } from "./ports";
import { runChatUseCase } from "./run-chat";
import { getCurrentTimeTool } from "@/lib/agent/tools/current-time";

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

function readyDependencies() {
  const dependencies = fakeDependencies();
  vi.mocked(dependencies.userContext.resolveModel).mockResolvedValue({
    id: "test", supportsTools: true, contextWindow: 32_000,
  } as Awaited<ReturnType<typeof dependencies.userContext.resolveModel>>);
  vi.mocked(dependencies.userContext.resolveMemoryConfig).mockResolvedValue(null);
  vi.mocked(dependencies.userContext.resolveUserProfile).mockResolvedValue({ content: "", configured: false, revision: 0 });
  vi.mocked(dependencies.userContext.readKnowledgeProfile).mockResolvedValue(null);
  vi.mocked(dependencies.sessions.resolveLoopMessages).mockResolvedValue({ messages: [{ role: "user", content: "你好" }], source: "client", originalMessageCount: 1, snapshot: null });
  const close = vi.fn(async () => {});
  dependencies.externalTools = { open: vi.fn(async () => ({ tools: [], close })) };
  return { dependencies, close };
}

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "你好" }], ...body }),
  });
}

describe("chat MCP lifecycle", () => {
  it("closes on an early invalid-plan response", async () => {
    const { dependencies, close } = readyDependencies();
    const response = await runChatUseCase({ request: request({ approvedPlan: {} }), userId: "user-1", dependencies });
    expect(response.status).toBe(400);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes if registration fails before constructing the stream", async () => {
    const { dependencies, close } = readyDependencies();
    vi.mocked(dependencies.externalTools!.open).mockResolvedValue({ tools: [getCurrentTimeTool], close });
    await expect(runChatUseCase({ request: request(), userId: "user-1", dependencies })).rejects.toThrow("already exists");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes when the stream producer fails outside the agent error handler", async () => {
    const { dependencies, close } = readyDependencies();
    vi.mocked(dependencies.telemetry.withTrace).mockRejectedValue(new Error("telemetry failed"));
    const response = await runChatUseCase({ request: request(), userId: "user-1", dependencies });
    await expect(response.text()).rejects.toThrow("telemetry failed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection until the producer finishes and closes on response cancellation", async () => {
    const { dependencies, close } = readyDependencies();
    let release!: () => void;
    vi.mocked(dependencies.telemetry.withTrace).mockImplementation(() => new Promise((resolve) => { release = () => resolve(undefined as never); }));
    const response = await runChatUseCase({ request: request(), userId: "user-1", dependencies });
    expect(close).not.toHaveBeenCalled();
    await response.body!.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    const openArgs = vi.mocked(dependencies.externalTools!.open).mock.calls[0][0];
    expect(openArgs.signal.aborted).toBe(true);
    release();
  });
});
