import { describe, expect, it, vi } from "vitest";
import { compactChatContextUseCase } from "./compact-context";
import type { ChatApplicationDependencies } from "./ports";

vi.mock("@/lib/agent/runtime", () => ({ callCompressionModel: vi.fn(async () => "目标：完成项目；约束：保留原始记录；下一步：验证功能。") }));

function dependencies(count: number): Pick<ChatApplicationDependencies, "sessions" | "userContext"> {
  return {
    userContext: {
      resolveModel: vi.fn().mockResolvedValue({ id: "model-1", contextWindow: 32_000 }),
      resolveMemoryConfig: vi.fn(), resolveUserProfile: vi.fn(), readKnowledgeProfile: vi.fn(),
    },
    sessions: {
      resolveLoopMessages: vi.fn().mockResolvedValue({
        messages: Array.from({ length: count }, (_, index) => ({
          role: index % 2 ? "assistant" : "user", content: `第${index}条：${"重要目标和约束。".repeat(100)}`,
        })), snapshot: { id: "existing", version: 3 },
      }),
      loadSnapshot: vi.fn(), persistTurn: vi.fn(), updateSystemPrompt: vi.fn(),
      createSnapshot: vi.fn().mockReturnValue({ id: "existing", version: 4 }),
      saveSnapshot: vi.fn(),
    },
  };
}

describe("manual context compaction", () => {
  it("saves a smaller snapshot for subsequent requests without writing chat history", async () => {
    const deps = dependencies(12);
    const result = await compactChatContextUseCase({ userId: "user-1", sessionId: "session-1", dependencies: deps });
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(deps.sessions.resolveLoopMessages).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", messages: [] });
    expect(deps.sessions.createSnapshot).toHaveBeenCalledWith(expect.objectContaining({ previous: { id: "existing", version: 3 } }));
    expect(deps.sessions.saveSnapshot).toHaveBeenCalledOnce();
    expect(deps.sessions.persistTurn).not.toHaveBeenCalled();
  });

  it("leaves short context unchanged", async () => {
    const deps = dependencies(2);
    const result = await compactChatContextUseCase({ userId: "user-1", sessionId: "session-1", dependencies: deps });
    expect(result.compacted).toBe(false);
    expect(deps.sessions.saveSnapshot).not.toHaveBeenCalled();
  });

  it("does not persist when the request was aborted", async () => {
    const deps = dependencies(12);
    const signal = AbortSignal.abort();
    await expect(compactChatContextUseCase({ userId: "user-1", sessionId: "session-1", signal, dependencies: deps })).rejects.toThrow();
    expect(deps.sessions.saveSnapshot).not.toHaveBeenCalled();
  });
});
