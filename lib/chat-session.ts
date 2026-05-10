export interface Message {
  role: "user" | "assistant";
  content: string;
}

export class ChatSession {
  id: string;
  title = "新对话";
  messages: Message[] = [];
  loading = false;
  streaming = false;
  error: string | null = null;
  private abortController: AbortController | null = null;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
  }

  async send(input: string, onUpdate: () => void) {
    if (!input.trim() || this.loading) return;

    this.loading = true;
    this.error = null;
    const userMessage: Message = { role: "user", content: input };
    this.messages.push(userMessage);

    if (this.messages.length === 1) {
      this.title = input.slice(0, 20) || "新对话";
    }

    this.messages.push({ role: "assistant", content: "" });
    onUpdate();

    try {
      this.abortController = new AbortController();
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: this.messages.slice(0, -1),
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error("请求失败, 请稍后重试");
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      this.streaming = true;
      onUpdate();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        this.messages[this.messages.length - 1].content += text;
        onUpdate();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      this.error = err instanceof Error ? err.message : "发生未知错误";
      const last = this.messages[this.messages.length - 1];
      if (last.role === "assistant" && !last.content) {
        this.messages.pop();
      }
    } finally {
      this.loading = false;
      this.streaming = false;
      this.abortController = null;
      onUpdate();
    }
  }

  abort() {
    this.abortController?.abort();
  }
}
