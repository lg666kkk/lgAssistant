import { compactLoopMessagesSemantic } from "@/lib/agent/runtime/compaction";
import { callCompressionModel } from "@/lib/agent/runtime";
import type { ChatApplicationDependencies } from "./ports";

export async function compactChatContextUseCase(input: {
  userId: string;
  sessionId: string;
  modelId?: string;
  signal?: AbortSignal;
  dependencies: Pick<ChatApplicationDependencies, "sessions" | "userContext">;
}) {
  const { sessions, userContext } = input.dependencies;
  const model = await userContext.resolveModel(input.userId, input.modelId);
  const history = await sessions.resolveLoopMessages({
    userId: input.userId, sessionId: input.sessionId, messages: [],
  });
  const result = await compactLoopMessagesSemantic(history.messages, {
    force: true,
    modelWindowTokens: Math.min(model.contextWindow, 32_000),
    primerMessages: 1,
    recentMessages: 4,
    summaryTokenBudget: 1_600,
    compressionModel: model.id,
    compressor: (request) => callCompressionModel({
      ...request, model: model.id, signal: input.signal,
      telemetryMetadata: { userId: input.userId, sessionId: input.sessionId },
    }),
  });
  input.signal?.throwIfAborted();
  const compacted = result.compacted && result.afterTokens < result.beforeTokens;
  if (compacted) {
    await sessions.saveSnapshot(sessions.createSnapshot({
      userId: input.userId, sessionId: input.sessionId, model: model.id,
      previous: history.snapshot ?? undefined, messages: result.messages,
    }));
  }
  return {
    compacted,
    beforeTokens: result.beforeTokens,
    afterTokens: compacted ? result.afterTokens : result.beforeTokens,
    message: compacted
      ? `上下文已压缩：约 ${result.beforeTokens} → ${result.afterTokens} tokens，原始聊天记录保留。`
      : "当前上下文较短，无需压缩。原始聊天记录保留。",
  };
}
