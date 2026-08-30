import { describe, expect, it, vi } from "vitest";
import type { PreviewChatContextInput } from "./preview-context";
import { previewChatContextUseCase } from "./preview-context";

function fakeDependencies(): PreviewChatContextInput["dependencies"] {
  return {
    userContext: {
      resolveModel: vi.fn().mockResolvedValue({
        id: "model-1",
        providerId: "provider-1",
        providerName: "Provider",
        modelId: "provider-model",
        displayName: "Test model",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        temperature: 0.2,
        supportsTools: true,
        supportsImages: true,
        reasoningMode: "none",
        enabled: true,
        userId: "user-1",
        adapterType: "openai-compatible",
        baseUrl: "https://example.invalid",
        apiKey: "not-used",
      }),
      resolveMemoryConfig: vi.fn().mockResolvedValue({ enabled: true }),
      resolveUserProfile: vi.fn().mockResolvedValue({
        content: "偏好中文回答，先给结论。",
        configured: true,
        revision: 3,
        updatedAt: "2026-08-29T00:00:00.000Z",
      }),
      readKnowledgeProfile: vi.fn().mockResolvedValue({
        profile: "个人知识库包含工程笔记。",
        sourceHash: "hash-1",
        indexVersion: "index-1",
      }),
    },
    sessions: {
      resolveLoopMessages: vi.fn().mockResolvedValue({
        messages: [
          { role: "user", content: "上一个问题" },
          { role: "assistant", content: "上一个回答" },
        ],
        source: "redis",
        originalMessageCount: 0,
        snapshot: null,
      }),
      persistTurn: vi.fn(),
      createSnapshot: vi.fn(),
      saveSnapshot: vi.fn(),
      updateSystemPrompt: vi.fn(),
    },
  };
}

describe("previewChatContextUseCase", () => {
  it("shows baseline system, profile, conversation and tool schema usage while idle", async () => {
    const dependencies = fakeDependencies();
    const usage = await previewChatContextUseCase({
      userId: "user-1",
      dependencies,
      sessionId: "session-1",
      modelId: "model-1",
      webSearchEnabled: true,
      draftText: "",
      imageCount: 0,
    });

    expect(usage.model).toBe("model-1");
    expect(usage.workingWindowTokens).toBe(32_000);
    expect(usage.breakdown?.systemTokens).toBeGreaterThan(0);
    expect(usage.breakdown?.userProfileTokens).toBeGreaterThan(0);
    expect(usage.breakdown?.conversationTokens).toBeGreaterThan(0);
    expect(usage.breakdown?.toolSchemaTokens).toBeGreaterThan(0);
    expect(
      Object.values(usage.breakdown ?? {}).reduce((sum, tokens) => sum + tokens, 0),
    ).toBe(usage.estimatedTokens);
    expect(usage.runBudget).toMatchObject({
      spentTokens: 0,
      maxTokens: 128_000,
      outputReserveTokens: 4_096,
    });
    expect(dependencies.userContext.resolveModel).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.resolveLoopMessages).toHaveBeenCalledTimes(1);
  });

  it("counts draft images without loading their binary data", async () => {
    const dependencies = fakeDependencies();
    vi.mocked(dependencies.sessions.resolveLoopMessages).mockImplementation(
      async ({ messages }) => ({
        messages,
        source: "client",
        originalMessageCount: messages.length,
        snapshot: null,
      }),
    );

    const withoutImage = await previewChatContextUseCase({
      userId: "user-1",
      dependencies,
      modelId: "model-1",
      draftText: "分析这张图",
      imageCount: 0,
    });
    const withImages = await previewChatContextUseCase({
      userId: "user-1",
      dependencies,
      modelId: "model-1",
      draftText: "分析这张图",
      imageCount: 2,
    });

    expect(withImages.estimatedTokens - withoutImage.estimatedTokens).toBeGreaterThanOrEqual(700);
  });
});

