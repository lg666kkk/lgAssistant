export function buildChatTraceInput(input: {
  requestId: string;
  sessionId?: string;
  userId: string;
  model: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const currentUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";

  return {
    requestId: input.requestId,
    sessionId: input.sessionId,
    userId: input.userId,
    model: input.model,
    query: currentUserMessage,
    messageCount: input.messages.length,
    historyPreview: input.messages.slice(0, -1).slice(-6).map((message) => ({
      role: message.role,
      chars: message.content.length,
      preview: message.content.slice(0, 160),
    })),
  };
}
