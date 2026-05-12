export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{
    title: string;
    notionPageId: string;
    pageUrl: string;
    similarity: number;
    excerpt: string;
  }>;
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

      let fullText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        fullText += text;

        // 检查是否包含来源标记
        const sourcesMarkerIndex = fullText.indexOf('\n\n__SOURCES__\n');
        if (sourcesMarkerIndex !== -1) {
          // 分离正文和来源数据
          const content = fullText.substring(0, sourcesMarkerIndex);
          const sourcesJson = fullText.substring(sourcesMarkerIndex + 14); // 14 = '\n\n__SOURCES__\n'.length

          try {
            const sources = JSON.parse(sourcesJson);
            this.messages[this.messages.length - 1].content = content;
            this.messages[this.messages.length - 1].sources = sources;
          } catch (e) {
            // JSON 解析失败，继续累积文本
            this.messages[this.messages.length - 1].content = fullText;
          }
        } else {
          // 还没有收到来源标记，继续累积文本
          this.messages[this.messages.length - 1].content = fullText;
        }

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
