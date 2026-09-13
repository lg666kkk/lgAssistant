import type Anthropic from "@anthropic-ai/sdk";
import type { ContextUsageEventData } from "@repo/contracts";
import { buildPromptPipe } from "@/lib/agent/prompt/pipe";
import {
  buildRetrievalPlan,
  filterToolsForRetrievalRoute,
} from "@/lib/agent/rag/retrieval-router";
import {
  buildContextUsageBreakdown,
  estimateModelRequestTokens,
} from "@/lib/agent/runtime/context-usage";
import {
  AGENT_LOOP_OUTPUT_RESERVE,
  AGENT_LOOP_TOKEN_BUDGET,
  CONTEXT_COMPACTION_WINDOW_CAP,
} from "@/lib/agent/runtime/limits";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { renderToolOrchestrationPolicy } from "@/lib/agent/tools/orchestration";
import { filterToolsForUserIntent } from "@/lib/agent/tools/tool-intent";
import type { ChatApplicationDependencies } from "./ports";
import { openExternalToolSession } from "../mcp/session";

type ModelMessage = Anthropic.MessageParam;

export type PreviewChatContextInput = {
  userId: string;
  dependencies: Pick<ChatApplicationDependencies, "userContext" | "sessions" | "externalTools">;
  signal?: AbortSignal;
  sessionId?: unknown;
  modelId?: unknown;
  webSearchEnabled?: unknown;
  draftText?: unknown;
  imageCount?: unknown;
};

function textFromMessage(message: ModelMessage) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
}

function buildDraftMessages(draftText: string, imageCount: number): ModelMessage[] {
  if (!draftText && imageCount === 0) return [];
  if (imageCount === 0) return [{ role: "user", content: draftText }];

  const content: Anthropic.MessageParam["content"] = [
    ...(draftText ? [{ type: "text" as const, text: draftText }] : []),
    ...Array.from({ length: imageCount }, () => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: "AA==",
      },
    })),
  ];
  return [{ role: "user", content }];
}

function emptyUserProfile() {
  return {
    content: "",
    configured: false,
    revision: 0,
    updatedAt: undefined,
  };
}

export async function previewChatContextUseCase(
  input: PreviewChatContextInput,
): Promise<ContextUsageEventData> {
  const deps = input.dependencies;
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
    ? input.sessionId
    : undefined;
  const modelId = typeof input.modelId === "string" && input.modelId.trim()
    ? input.modelId
    : undefined;
  const draftText = typeof input.draftText === "string"
    ? input.draftText.slice(0, 100_000)
    : "";
  const imageCount = Number.isInteger(input.imageCount)
    ? Math.min(10, Math.max(0, Number(input.imageCount)))
    : 0;
  const webSearchEnabled = input.webSearchEnabled !== false;

  const selectedModel = await deps.userContext.resolveModel(input.userId, modelId);
  if (imageCount > 0 && !selectedModel.supportsImages) {
    throw new Error("当前模型未启用图片输入能力");
  }

  const draftMessages = buildDraftMessages(draftText, imageCount);
  let messages = draftMessages;
  try {
    messages = (await deps.sessions.resolveLoopMessages({
      userId: input.userId,
      sessionId,
      messages: draftMessages,
    })).messages;
  } catch (error) {
    console.error(
      "[context-preview] 读取会话历史失败，使用当前草稿:",
      error instanceof Error ? error.message : error,
    );
  }

  const [knowledgeSnapshot, memoryConfig, userProfile] = await Promise.all([
    deps.userContext.readKnowledgeProfile(input.userId).catch((error) => {
      console.error(
        "[context-preview] 读取知识库画像失败:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
    deps.userContext.resolveMemoryConfig(input.userId).catch((error) => {
      console.error(
        "[context-preview] 读取记忆配置失败:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }),
    deps.userContext.resolveUserProfile(input.userId).catch((error) => {
      console.error(
        "[context-preview] 读取用户画像失败:",
        error instanceof Error ? error.message : error,
      );
      return emptyUserProfile();
    }),
  ]);

  const conversationContext = messages
    .slice(0, draftMessages.length > 0 ? -1 : undefined)
    .map(textFromMessage)
    .filter(Boolean);
  const retrievalPlan = buildRetrievalPlan({
    query: draftText,
    conversationContext,
    knowledgeProfile: knowledgeSnapshot?.profile,
    indexVersion: knowledgeSnapshot?.indexVersion,
    webEnabled: webSearchEnabled,
  });
  const toolRegistry = createBuiltinToolRegistry({
    knowledgeProfile: knowledgeSnapshot?.profile,
    retrievalPlan,
  });
  const external = await openExternalToolSession({
    port: selectedModel.supportsTools ? deps.externalTools : undefined,
    userId: input.userId,
    signal: input.signal ?? new AbortController().signal,
  });
  try {
    for (const tool of external.tools) toolRegistry.register(tool);
  } finally {
    // Preview only needs schemas; it never executes remote tools.
    await external.close();
  }
  const routeToolDefinitions = filterToolsForRetrievalRoute(
    toolRegistry.list(),
    retrievalPlan.route,
    { webEnabled: webSearchEnabled },
  ).filter((tool) =>
    memoryConfig?.enabled
    || !["recall_memory", "search_memory_history"].includes(tool.name));
  const tools = selectedModel.supportsTools
    ? filterToolsForUserIntent(
        toolRegistry.listForModel(routeToolDefinitions),
        draftText,
      )
    : [];
  const prompt = buildPromptPipe({
    userMessage: draftText,
    userProfile: userProfile.content,
    userProfileMetadata: {
      type: "user_profile",
      revision: userProfile.revision,
      updatedAt: userProfile.updatedAt,
      contentChars: userProfile.content.length,
    },
    webSearchEnabled,
    toolOrchestration: renderToolOrchestrationPolicy(
      routeToolDefinitions,
      retrievalPlan,
    ),
    retrievalPlan,
    maxTokens: 4_200,
  });
  const estimatedTokens = estimateModelRequestTokens({
    messages,
    system: prompt.systemPrompt,
    tools,
  });
  const modelWindowTokens = selectedModel.contextWindow;
  const workingWindowTokens = Math.min(
    modelWindowTokens,
    CONTEXT_COMPACTION_WINDOW_CAP,
  );
  const requiredTokens = estimatedTokens + AGENT_LOOP_OUTPUT_RESERVE;

  return {
    model: selectedModel.id,
    modelCallIndex: 1,
    estimatedTokens,
    workingWindowTokens,
    modelWindowTokens,
    remainingTokens: Math.max(0, workingWindowTokens - estimatedTokens),
    phase: "before_model",
    breakdown: buildContextUsageBreakdown({
      messages,
      system: prompt.systemPrompt,
      tools,
      systemSegments: prompt.segments,
      totalTokens: estimatedTokens,
    }),
    runBudget: {
      spentTokens: 0,
      maxTokens: AGENT_LOOP_TOKEN_BUDGET,
      remainingTokens: AGENT_LOOP_TOKEN_BUDGET,
      nextRequestTokens: estimatedTokens,
      outputReserveTokens: AGENT_LOOP_OUTPUT_RESERVE,
      requiredTokens,
      canContinue: requiredTokens <= AGENT_LOOP_TOKEN_BUDGET,
    },
  };
}
