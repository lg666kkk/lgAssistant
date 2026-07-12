import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import { getAccessToken, authFetch } from "@/lib/auth/client";
import type { ChatModelId } from "@/lib/agent/models";
import type { ContextUsageEventData } from "@/lib/agent/runtime/events";
import type { ModelUsageEventData } from "@/lib/agent/runtime/events";
import type { AgentEvent } from "@/lib/agent/runtime/events";
import { SessionManager } from "./session-manager";
export interface Message {
  id?: string;
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
    metadata?: Record<string, unknown>;
  }>;
  modelUsages?: ModelUsageEventData[];
}

export class ChatSession {
  id: string;
  title = "新对话";
  messages: Message[] = [];
  loading = false;
  streaming = false;
  error: string | null = null;
  contextUsage: ContextUsageEventData | null = null;
  private abortController: AbortController | null = null;
  private manuallyAborted = false;
  private currentModel: ChatModelId | null = null;
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
        id: msg.id,
        role: msg.role,
        content: msg.content,
        sources: msg.sources,
        toolCalls: msg.metadata?.toolCalls,
        modelUsages: msg.metadata?.modelUsages,
      }));
      this.isNewSession = false;
    } catch (error) {
      console.error("加载会话失败:", error);
      // 如果加载失败，可能是新会话，继续使用内存数据
    }
  }

  async send(
    input: string,
    onUpdate: () => void,
    options: {
      webSearchEnabled?: boolean;
      model?: ChatModelId;
    } = {},
  ) {
    if (!input.trim() || this.loading) return;

    this.loading = true;
    this.currentModel = options.model ?? null;
    this.manuallyAborted = false;
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
      this.streaming = true;
      onUpdate();
      const accessToken = await getAccessToken();

      const last = () => this.messages[this.messages.length - 1];

      // 按事件类型分发，handleEvent 逻辑不变——只是"怎么收事件"换成了库
      const handleEvent = (evt: AgentEvent) => {
        switch (evt.type) {
          case "text":
            last().content += evt.content;
            break;
          case "tool_call":
            (last().toolCalls ??= []).push(evt.toolCall);
            break;
          case "sources":
            last().sources = evt.sources;
            break;
          case "model_usage":
            (last().modelUsages ??= []).push(evt.usage);
            break;
          case "context_usage":
            this.contextUsage = evt.usage;
            void this.sessionManager
              .updateSessionContextUsage(this.id, evt.usage)
              .catch((error) =>
                console.error("保存会话上下文用量失败:", error),
              );
            break;
          case "error":
            throw new Error(evt.message || evt.error || "流式响应中断");
          case "done":
            break;
        }
      };

      await fetchEventSource("/api/chat", {
        method: "POST",
        openWhenHidden: true,
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          // 只发送本轮用户消息；历史上下文由服务端通过 Redis sessionId 补齐。
          messages: [userMessage],
          sessionId: this.id,
          enableWebSearch: options.webSearchEnabled !== false,
          model: options.model,
        }),
        signal: this.abortController.signal,
        onopen: async (response) => {
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            // FatalError：告诉库这是不可重试的错误，直接 reject 不重连
            throw new Error(errorData.error || errorData.message || "请求失败");
          }
          // 检查 Content-Type，不是 SSE 就 throw（和库的 defaultOnOpen 行为一致）
          const ct = response.headers.get("content-type");
          if (!ct?.startsWith(EventStreamContentType)) {
            throw new Error(`非 SSE 响应: ${ct}`);
          }
        },
        onmessage: (ev) => {
          if (!ev.data) return;
          let evt: AgentEvent;
          try {
            evt = JSON.parse(ev.data);
          } catch {
            // 忽略 parse 失败的单条事件
            return;
          }

          handleEvent(evt);
          onUpdate();
        },
        onclose: () => {
          // 服务端正常关闭流，不需要任何处理
        },
        onerror: (err) => {
          if (this.manuallyAborted || this.abortController?.signal.aborted) {
            throw new DOMException("用户已停止生成", "AbortError");
          }
          // throw 让库停止重连，交给外层 catch 处理
          throw err;
        },
      });

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
    this.manuallyAborted = true;
    this.loading = false;
    this.streaming = false;
    this.abortController?.abort();
  }

  get isRunning() {
    return this.loading || this.streaming;
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
      const save = await this.sessionManager.saveAssistantMessage(
        this.id,
        lastMessage.content,
        {
          sources: lastMessage.sources,
          model: this.currentModel ?? "deepseek-v4-pro",
          metadata: {
            ...metadata,
            toolCalls: lastMessage.toolCalls,
            modelUsages: lastMessage.modelUsages,
          },
        },
      );
      console.log("xxxx", save);
      lastMessage.id = save.id;
      return true;
    } catch (error) {
      console.error("保存 AI 回复失败:", error);
      return false;
    }
  }

  async confirmToolCall(messageIndex: number, toolCallIndex: number) {
    const message = this.messages[messageIndex];
    const toolCall = message?.toolCalls?.[toolCallIndex];
    if (!message || !toolCall) return;
    const response = await authFetch("/api/tools/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.id,
        toolCall:
          typeof toolCall.metadata?.toolCall === "object" &&
          toolCall.metadata.toolCall !== null
            ? toolCall.metadata.toolCall
            : { name: toolCall.name, input: toolCall.input },
      }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.error || errorData.message || "确认工具调用失败",
      );
    }
    const result = await response.json();
    toolCall.ok = Boolean(result.ok);
    toolCall.content = String(result.content ?? "");
    toolCall.error =
      typeof result.error === "string" ? result.error : undefined;
    toolCall.metadata = {
      ...toolCall.metadata,
      status: result.ok ? "confirmed" : "failed",
      confirmedAt: new Date().toISOString(),
      result,
    };
    if (message.id) {
      await this.sessionManager.updateMessageMetadata(message.id, {
        toolCalls: message.toolCalls,
      });
    }
  }
  async cancelToolCall(messageIndex: number, toolCallIndex: number) {
    const message = this.messages[messageIndex];
    const toolCall = message?.toolCalls?.[toolCallIndex];

    if (!message || !toolCall) return;

    toolCall.ok = false;
    toolCall.content = "用户已取消执行";
    toolCall.metadata = {
      ...toolCall.metadata,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    };

    if (message.id) {
      await this.sessionManager.updateMessageMetadata(message.id, {
        toolCalls: message.toolCalls,
      });
    }
  }
}
