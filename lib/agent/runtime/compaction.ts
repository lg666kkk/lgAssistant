import { estimateTokens } from "./budget";
import type Anthropic from "@anthropic-ai/sdk";

type ModelMessage = Anthropic.MessageParam;

export type CompactLoopMessagesOptions = {
  modelWindowTokens?: number;
  triggerRatio?: number;
  targetRatio?: number;
  primerMessages?: number;
  recentMessages?: number;
  minNewMessagesSinceLastCompression?: number;
  lastCompactedMessageCount?: number;
  // Backward-compatible legacy options.
  maxTokens?: number;
  keepRecentMessages?: number;
};

export type SemanticCompressor = (input: {
  digest: string;
  targetTokens: number;
  middleMessageCount: number;
}) => Promise<string>;

export type CompactLoopMessagesResult = {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
  reason?: string;
  modelWindowTokens: number;
  triggerTokens: number;
  targetTokens: number;
  primerMessages: number;
  recentMessages: number;
  middleMessageCount: number;
  skippedReason?: string;
  method?: "deterministic" | "semantic";
  compressionModel?: string;
  fallbackReason?: string;
};

const DEFAULT_POLICY = {
  modelWindowTokens: 32_000,
  triggerRatio: 0.75,
  targetRatio: 0.375,
  primerMessages: 3,
  recentMessages: 6,
  minNewMessagesSinceLastCompression: 8,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeOptions(options: CompactLoopMessagesOptions) {
  const modelWindowTokens =
    options.modelWindowTokens ?? options.maxTokens ?? DEFAULT_POLICY.modelWindowTokens;
  const triggerRatio = clamp(options.triggerRatio ?? 1, 0.1, 1);
  const targetRatio = clamp(options.targetRatio ?? DEFAULT_POLICY.targetRatio, 0.1, 0.9);
  const primerMessages = Math.max(0, Math.floor(options.primerMessages ?? 1));
  const recentMessages = Math.max(
    1,
    Math.floor(options.recentMessages ?? options.keepRecentMessages ?? DEFAULT_POLICY.recentMessages),
  );

  return {
    modelWindowTokens,
    triggerRatio,
    targetRatio,
    primerMessages,
    recentMessages,
    minNewMessagesSinceLastCompression:
      options.minNewMessagesSinceLastCompression ??
      DEFAULT_POLICY.minNewMessagesSinceLastCompression,
    lastCompactedMessageCount: options.lastCompactedMessageCount,
    triggerTokens: Math.floor(modelWindowTokens * triggerRatio),
    targetTokens: Math.floor(modelWindowTokens * targetRatio),
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      const item = block as unknown as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      if (item.type === "tool_use") {
        return `tool_use ${String(item.name ?? "(unknown)")}: ${JSON.stringify(item.input ?? {})}`;
      }
      if (item.type === "tool_result") {
        return `tool_result ${String(item.tool_use_id ?? "")}: ${String(item.content ?? "")}`;
      }
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

function truncateText(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function summarizeMessage(message: ModelMessage, index: number) {
  const role = message.role;
  const content = message.content;
  const text = textFromContent(content);

  if (Array.isArray(content)) {
    const toolUses = content
      .filter(
        (block): block is Anthropic.Messages.ToolUseBlock =>
          !!block && typeof block === "object" && block.type === "tool_use",
      )
      .map((block) => `调用 ${block.name}(${truncateText(JSON.stringify(block.input), 220)})`);
    const toolResults = content.flatMap((block) => {
      if (!block || typeof block !== "object" || block.type !== "tool_result") {
        return [];
      }
      const item = block as unknown as Record<string, unknown>;
      const status = item.is_error === true ? "失败" : "成功";
      return [
        `工具结果${status}: ${truncateText(textFromContent(item.content), 260)}`,
      ];
    });

    const parts = [...toolUses, ...toolResults];
    if (parts.length > 0) {
      return `${index + 1}. ${role}: ${parts.join("；")}`;
    }
  }

  return `${index + 1}. ${role}: ${truncateText(text, 360)}`;
}

function buildStructuredSummary(messages: ModelMessage[], targetTokens: number) {
  const maxChars = Math.max(1_200, targetTokens * 4);
  const lines = messages.map(summarizeMessage);
  const body = lines.join("\n");
  const truncatedBody =
    body.length <= maxChars
      ? body
      : `${body.slice(0, maxChars)}\n...（中间历史摘要已按目标长度截断，原始摘要 ${body.length} 字符）`;

  return [
    "## 用户目标",
    "- 见早期保留消息；本摘要只压缩中间历史。",
    "",
    "## 重要约束",
    "- 保留用户已经明确提出的限制、偏好和禁止事项；如未出现在中间历史，则以早期消息和最近消息为准。",
    "",
    "## 已完成工作 / 当前状态 / 工具结果",
    truncatedBody || "- 中间历史为空。",
    "",
    "## 下一步建议",
    "- 继续基于早期目标、上述摘要和最近完整消息完成当前任务。",
  ].join("\n");
}

function splitMessagesForCompaction(
  messages: ModelMessage[],
  policy: ReturnType<typeof normalizeOptions>,
) {
  if (messages.length <= 2) {
    return {
      primerCount: Math.min(1, messages.length),
      recentCount: Math.max(0, messages.length - 1),
      primerMessages: messages.slice(0, 1),
      recentMessages: messages.slice(1),
      middleMessages: [],
    };
  }

  const maxPrimerCount = Math.max(1, messages.length - 2);
  const primerCount = Math.min(policy.primerMessages, maxPrimerCount);
  const remainingAfterPrimers = messages.length - primerCount;
  const maxRecentCount = Math.max(1, remainingAfterPrimers - 1);
  const recentCount = Math.min(
    policy.recentMessages,
    maxRecentCount,
  );
  const primerMessages = messages.slice(0, primerCount);
  const recentMessages =
    recentCount > 0 ? messages.slice(messages.length - recentCount) : [];
  const middleMessages = messages.slice(
    primerCount,
    messages.length - recentCount,
  );

  return {
    primerCount,
    recentCount,
    primerMessages,
    recentMessages,
    middleMessages,
  };
}

function buildCompactedMessages(input: {
  primerMessages: ModelMessage[];
  summary: string;
  recentMessages: ModelMessage[];
}): ModelMessage[] {
  return [
    ...input.primerMessages,
    {
      role: "user",
      content: `以下是较早中间上下文的结构化压缩摘要，用于继续当前任务；摘要可能省略细节，请优先结合最近完整消息判断当前状态。\n\n${input.summary}`,
    },
    ...input.recentMessages,
  ];
}

export function compactLoopMessages(
  messages: ModelMessage[],
  options: CompactLoopMessagesOptions,
): CompactLoopMessagesResult {
  const policy = normalizeOptions(options);
  const beforeTokens = estimateTokens(messages);

  if (beforeTokens <= policy.triggerTokens) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: policy.primerMessages,
      recentMessages: policy.recentMessages,
      middleMessageCount: 0,
      skippedReason: "below_threshold",
    };
  }

  if (
    typeof policy.lastCompactedMessageCount === "number" &&
    messages.length - policy.lastCompactedMessageCount <
      policy.minNewMessagesSinceLastCompression
  ) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: policy.primerMessages,
      recentMessages: policy.recentMessages,
      middleMessageCount: 0,
      skippedReason: "rate_limited",
    };
  }

  const {
    primerCount,
    recentCount,
    primerMessages,
    recentMessages,
    middleMessages,
  } = splitMessagesForCompaction(messages, policy);

  if (middleMessages.length === 0) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: primerCount,
      recentMessages: recentCount,
      middleMessageCount: 0,
      skippedReason: "no_middle_messages",
    };
  }

  const summary = buildStructuredSummary(middleMessages, policy.targetTokens);
  const compactedMessages = buildCompactedMessages({
    primerMessages,
    summary,
    recentMessages,
  });

  return {
    messages: compactedMessages,
    compacted: true,
    beforeTokens,
    afterTokens: estimateTokens(compactedMessages),
    summary,
    reason: "estimated_context_above_threshold",
    modelWindowTokens: policy.modelWindowTokens,
    triggerTokens: policy.triggerTokens,
    targetTokens: policy.targetTokens,
    primerMessages: primerCount,
    recentMessages: recentCount,
    middleMessageCount: middleMessages.length,
    method: "deterministic",
  };
}

export async function compactLoopMessagesSemantic(
  messages: ModelMessage[],
  options: CompactLoopMessagesOptions & {
    compressor: SemanticCompressor;
    compressionModel?: string;
  },
): Promise<CompactLoopMessagesResult> {
  const policy = normalizeOptions(options);
  const beforeTokens = estimateTokens(messages);

  if (beforeTokens <= policy.triggerTokens) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: policy.primerMessages,
      recentMessages: policy.recentMessages,
      middleMessageCount: 0,
      skippedReason: "below_threshold",
      method: "semantic",
      compressionModel: options.compressionModel,
    };
  }

  if (
    typeof policy.lastCompactedMessageCount === "number" &&
    messages.length - policy.lastCompactedMessageCount <
      policy.minNewMessagesSinceLastCompression
  ) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: policy.primerMessages,
      recentMessages: policy.recentMessages,
      middleMessageCount: 0,
      skippedReason: "rate_limited",
      method: "semantic",
      compressionModel: options.compressionModel,
    };
  }

  const {
    primerCount,
    recentCount,
    primerMessages,
    recentMessages,
    middleMessages,
  } = splitMessagesForCompaction(messages, policy);

  if (middleMessages.length === 0) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: primerCount,
      recentMessages: recentCount,
      middleMessageCount: 0,
      skippedReason: "no_middle_messages",
      method: "semantic",
      compressionModel: options.compressionModel,
    };
  }

  const digest = middleMessages.map(summarizeMessage).join("\n");

  try {
    const summary = await options.compressor({
      digest,
      targetTokens: policy.targetTokens,
      middleMessageCount: middleMessages.length,
    });
    const safeSummary = summary.trim();
    if (!safeSummary) {
      throw new Error("empty semantic summary");
    }

    const compactedMessages = buildCompactedMessages({
      primerMessages,
      summary: safeSummary,
      recentMessages,
    });

    return {
      messages: compactedMessages,
      compacted: true,
      beforeTokens,
      afterTokens: estimateTokens(compactedMessages),
      summary: safeSummary,
      reason: "semantic_context_compaction",
      modelWindowTokens: policy.modelWindowTokens,
      triggerTokens: policy.triggerTokens,
      targetTokens: policy.targetTokens,
      primerMessages: primerCount,
      recentMessages: recentCount,
      middleMessageCount: middleMessages.length,
      method: "semantic",
      compressionModel: options.compressionModel,
    };
  } catch (error) {
    const fallback = compactLoopMessages(messages, options);
    return {
      ...fallback,
      method: fallback.compacted ? "deterministic" : "semantic",
      compressionModel: options.compressionModel,
      fallbackReason:
        error instanceof Error ? error.message : "semantic compression failed",
    };
  }
}
