import { SessionManager } from "./session-manager";

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
  toolCalls?: Array<{
    name: string;
    input?: unknown;
    ok: boolean;
    content: string;
    error?: string;
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
  private sessionManager = new SessionManager();
  private isNewSession = true;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();
  }

  /**
   * 从数据库加载会话数据
   */
  async loadFromDatabase(): Promise<void> {
    try {
      const dbMessages = await this.sessionManager.getMessages(this.id);
      this.messages = dbMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
        sources: msg.sources,
        toolCalls: msg.metadata?.toolCalls,
      }));
      this.isNewSession = false;
    } catch (error) {
      console.error("加载会话失败:", error);
      // 如果加载失败，可能是新会话，继续使用内存数据
    }
  }

  async send(input: string, onUpdate: () => void) {
    if (!input.trim() || this.loading) return;

    this.loading = true;
    this.error = null;
    let assistantMessageSaved = false;
    const userMessage: Message = { role: "user", content: input };
    this.messages.push(userMessage);

    // 如果是新会话，先创建数据库记录
    if (this.isNewSession) {
      try {
        await this.sessionManager.createSession(this.title, this.id);
        this.isNewSession = false;
      } catch (error) {
        console.error("创建会话失败:", error);
      }
    }

    // 保存用户消息到数据库
    try {
      await this.sessionManager.saveUserMessage(this.id, input);
    } catch (error) {
      console.error("保存用户消息失败:", error);
    }

    if (this.messages.length === 1) {
      this.title = input.slice(0, 20) || "新对话";
      // 更新数据库中的标题
      try {
        await this.sessionManager.updateSessionTitle(this.id, this.title);
      } catch (error) {
        console.error("更新标题失败:", error);
      }
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || errorData.message || "请求失败, 请稍后重试",
        );
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      this.streaming = true;
      onUpdate();
      // fullText：原始响应，包含协议标记
      let fullText = "";
      const toolMarker = "__TOOL_CALL__";
      const sourcesMarker = "\n\n__SOURCES__\n";
      const endToolMarker = "__END_TOOL_CALL__";
      const parsedToolCallJsonSet = new Set<string>(); // 防止工具被重复追加
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        fullText += text;

        // 检查是否包含错误标记
        const errorMarkerIndex = fullText.indexOf("\n\n__ERROR__\n");
        if (errorMarkerIndex !== -1) {
          const errorJson = fullText.substring(errorMarkerIndex + 12); // 12 = '\n\n__ERROR__\n'.length
          try {
            const errorData = JSON.parse(errorJson);
            throw new Error(
              errorData.message || errorData.error || "流式响应中断",
            );
          } catch (e) {
            if (e instanceof Error && e.message !== "流式响应中断") {
              throw new Error("流式响应中断");
            }
            throw e;
          }
        }
        // displayText 是去掉标记后的显示内容
        let displayText = fullText;
        // 检测工具调用
        let toolMarkerIndex = displayText.indexOf(toolMarker);
        let endToolMarkerIndex = displayText.indexOf(endToolMarker);
        while (toolMarkerIndex !== -1 && endToolMarkerIndex !== -1) {
          const toolJson = displayText.substring(
            toolMarkerIndex + toolMarker.length,
            endToolMarkerIndex,
          );

          try {
            if (!parsedToolCallJsonSet.has(toolJson)) {
              const toolCall = JSON.parse(toolJson);
              const currentToolCalls =
                this.messages[this.messages.length - 1].toolCalls ?? [];

              this.messages[this.messages.length - 1].toolCalls = [
                ...currentToolCalls,
                toolCall,
              ];
              parsedToolCallJsonSet.add(toolJson);
            }
            displayText =
              displayText.substring(0, toolMarkerIndex) +
              displayText.substring(endToolMarkerIndex + endToolMarker.length);
            displayText = displayText.trimStart();
            toolMarkerIndex = displayText.indexOf(toolMarker);
            endToolMarkerIndex = displayText.indexOf(endToolMarker);
          } catch (e) {
            // JSON 解析失败，先保留原始文本
          }
        }
        // 检查是否包含来源标记
        const sourcesMarkerIndex = displayText.indexOf(sourcesMarker);
        if (sourcesMarkerIndex !== -1) {
          // 分离正文和来源数据
          const content = displayText.substring(0, sourcesMarkerIndex);
          const sourcesJson = displayText.substring(
            sourcesMarkerIndex + sourcesMarker.length,
          );

          try {
            const sources = JSON.parse(sourcesJson);
            this.messages[this.messages.length - 1].content = content;
            this.messages[this.messages.length - 1].sources = sources;
          } catch (e) {
            // JSON 解析失败，继续累积文本
            this.messages[this.messages.length - 1].content = displayText;
          }
        } else {
          // 还没有收到来源标记，继续累积文本
          this.messages[this.messages.length - 1].content = displayText;
        }

        onUpdate();
      }

      assistantMessageSaved = await this.saveCurrentAssistantMessage();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        if (!assistantMessageSaved) {
          await this.saveCurrentAssistantMessage({ interrupted: true });
        }
        return;
      }
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

  private async saveCurrentAssistantMessage(
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const lastMessage = this.messages[this.messages.length - 1];
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      !lastMessage.content.trim()
    ) {
      return false;
    }

    try {
      await this.sessionManager.saveAssistantMessage(
        this.id,
        lastMessage.content,
        {
          sources: lastMessage.sources,
          model: "deepseek-v4-pro",
          metadata: {
            ...metadata,
            toolCalls: lastMessage.toolCalls,
          },
        },
      );
      return true;
    } catch (error) {
      console.error("保存 AI 回复失败:", error);
      return false;
    }
  }
}
