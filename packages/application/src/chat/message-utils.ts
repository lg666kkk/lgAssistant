export function extractLastAssistantText(messages: unknown[]) {
  return [...messages]
    .reverse()
    .reduce((found: string, message: any) => {
      if (found || message.role !== "assistant") return found;
      const text = Array.isArray(message.content)
        ? message.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("")
        : typeof message.content === "string" ? message.content : "";
      return text || found;
    }, "");
}
