import type Anthropic from "@anthropic-ai/sdk";
import { CONTEXT_COMPACTION_WINDOW_CAP } from "./limits";
import { estimateModelRequestTokens } from "./context-usage";
import { compactLoopMessages } from "./compaction";
import { truncateToolContent } from "./budget";

export function getRequestContextLimits(contextWindow: number, maxOutputTokens: number) {
  const workingWindowTokens = Math.min(contextWindow, CONTEXT_COMPACTION_WINDOW_CAP);
  const safetyMarginTokens = Math.max(512, Math.ceil(workingWindowTokens * 0.01));
  return {
    workingWindowTokens,
    outputReserveTokens: maxOutputTokens,
    safetyMarginTokens,
    inputLimitTokens: Math.max(0, workingWindowTokens - maxOutputTokens - safetyMarginTokens),
  };
}

/** Produces a request view without changing the stored conversation or snapshot. */
export function prepareRequestContext(input: {
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  system?: string;
  contextWindow: number;
  maxOutputTokens: number;
}) {
  const limits = getRequestContextLimits(input.contextWindow, input.maxOutputTokens);
  let messages = input.messages;
  let estimatedTokens = estimateModelRequestTokens({ ...input, messages });
  let compacted = false;
  if (estimatedTokens > limits.inputLimitTokens) {
    const fixedTokens = estimateModelRequestTokens({ ...input, messages: [] });
    const historyLimit = Math.max(1, limits.inputLimitTokens - fixedTokens);
    const result = compactLoopMessages(messages, {
      modelWindowTokens: historyLimit,
      targetRatio: 0.75,
      primerMessages: 1,
      recentMessages: 2,
      summaryTokenBudget: Math.min(1600, Math.max(256, Math.floor(historyLimit * 0.15))),
      force: true,
    });
    messages = result.messages;
    compacted = result.compacted;
    estimatedTokens = estimateModelRequestTokens({ ...input, messages });
    if (estimatedTokens > limits.inputLimitTokens) {
      // Keep tool IDs and leading receipt metadata while reducing oversized result bodies.
      messages = messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.map((block) => {
          if (block.type !== "tool_result" || typeof block.content !== "string") return block;
          const trimmed = truncateToolContent(block.content, Math.max(256, Math.min(2048, Math.floor(historyLimit / 4))));
          compacted ||= trimmed.truncated;
          return { ...block, content: trimmed.content };
        }) : message.content,
      }));
      estimatedTokens = estimateModelRequestTokens({ ...input, messages });
    }
  }
  return {
    ...limits,
    messages,
    estimatedTokens,
    compacted,
    canFit: estimatedTokens <= limits.inputLimitTokens,
    availableInputTokens: Math.max(0, limits.inputLimitTokens - estimatedTokens),
  };
}

export function assertRequestContextFits(prepared: ReturnType<typeof prepareRequestContext>) {
  if (!prepared.canFit) throw new Error("当前输入和工具定义超过所选模型的上下文容量，压缩历史后仍不足。请缩短输入、减少工具或选择更大窗口的模型。");
}
