import { estimateTokens } from "./budget";

type ModelMessage = any;

export function compactLoopMessages(
  messages: ModelMessage[],
  options: {
    maxTokens: number;
    keepRecentMessages: number;
  },
): {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
} {
  const beforeTokens = estimateTokens(messages);

  if (beforeTokens <= options.maxTokens) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const firstMessage = messages[0];
  const recentMessages = messages.slice(-options.keepRecentMessages);
  const olderMessages = messages.slice(1, -options.keepRecentMessages);

  const summary = olderMessages
    .map((message, index) => {
      return `[${index + 1}] ${message.role}: ${JSON.stringify(message.content).slice(0, 300)}`;
    })
    .join("\n");

  const compactedMessages = [
    firstMessage,
    {
      role: "user",
      content: `以下是较早上下文的压缩摘要，用于避免上下文过长：\n${summary}`,
    },
    ...recentMessages,
  ];

  return {
    messages: compactedMessages,
    compacted: true,
    beforeTokens,
    afterTokens: estimateTokens(compactedMessages),
  };
}