import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import { getAccessToken, authFetch } from "@web/lib/auth/client";
import type {
  AgentEvent,
  ChatModelId,
  ContextUsageEventData,
  ExecutionPlanData,
  ModelUsageEventData,
  PlanExecutionControlData,
  PlanProgressEventData,
  ReasoningEventData,
} from "@repo/contracts";
import { SessionManager } from "./session-manager";
import { sanitizeModelText } from "@/lib/agent/runtime/output-sanitizer";
import { createUuid } from "@/lib/platform/uuid";
import {
  toPersistedImageAttachment,
  type ChatImageAttachment,
} from "@/lib/agent/multimodal";
export interface Message {
  id?: string;
  createdAt?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatImageAttachment[];
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
  reasoning?: ReasoningEventData[];
  planSteps?: PlanProgressEventData[];
  plan?: ExecutionPlanData;
}

export class ChatSession {
  private static readonly MESSAGE_PAGE_SIZE = 50;

  id: string;
  title = "新对话";
  messages: Message[] = [];
  loading = false;
  streaming = false;
  error: string | null = null;
  contextUsage: ContextUsageEventData | null = null;
  historyLoading = false;
  historyLoaded: boolean;
  hasOlderMessages = false;
  private abortController: AbortController | null = null;
  private manuallyAborted = false;
  private currentModel: ChatModelId | null = null;
  private sessionManager: SessionManager;
  private isNewSession: boolean;
  private historyLoadPromise: Promise<void> | null = null;

  constructor(id?: string, userId?: string, sessionManager?: SessionManager) {
    this.id = id ?? createUuid();
    this.isNewSession = !id;
    this.historyLoaded = !id;
    this.sessionManager = sessionManager ?? new SessionManager(userId);
  }

  private mapDatabaseMessage(msg: import("./session-manager").Message): Message {
    return {
      id: msg.id,
      createdAt: msg.created_at,
      role: msg.role,
      content: msg.content,
      attachments: msg.metadata?.attachments,
      sources: msg.sources,
      toolCalls: msg.metadata?.toolCalls,
      modelUsages: msg.metadata?.modelUsages,
      reasoning: msg.metadata?.reasoning,
      planSteps: msg.metadata?.planSteps,
      plan: msg.metadata?.plan,
    };
  }

  /**
   * 从数据库加载会话数据
   */
  async loadFromDatabase(): Promise<void> {
    if (this.historyLoaded) return;
    if (this.historyLoadPromise) return this.historyLoadPromise;

    this.historyLoading = true;
    this.historyLoadPromise = (async () => {
      try {
        const dbMessages = await this.sessionManager.getMessages(this.id, {
          limit: ChatSession.MESSAGE_PAGE_SIZE,
        });
        this.messages = dbMessages.map((message) => this.mapDatabaseMessage(message));
        this.hasOlderMessages = dbMessages.length === ChatSession.MESSAGE_PAGE_SIZE;
        this.historyLoaded = true;
      } catch (error) {
        console.error("加载会话失败:", error);
      } finally {
        this.historyLoading = false;
        this.historyLoadPromise = null;
      }
    })();
    return this.historyLoadPromise;
  }

  async loadOlderMessages(): Promise<void> {
    if (this.historyLoading || !this.historyLoaded || !this.hasOlderMessages) return;
    const before = this.messages.find((message) => message.createdAt)?.createdAt;
    if (!before) {
      this.hasOlderMessages = false;
      return;
    }

    this.historyLoading = true;
    try {
      const dbMessages = await this.sessionManager.getMessages(this.id, {
        limit: ChatSession.MESSAGE_PAGE_SIZE,
        before,
      });
      const knownIds = new Set(this.messages.flatMap((message) => message.id ? [message.id] : []));
      const older = dbMessages
        .filter((message) => !knownIds.has(message.id))
        .map((message) => this.mapDatabaseMessage(message));
      this.messages = [...older, ...this.messages];
      this.hasOlderMessages = dbMessages.length === ChatSession.MESSAGE_PAGE_SIZE;
    } catch (error) {
      console.error("加载更早消息失败:", error);
    } finally {
      this.historyLoading = false;
    }
  }

  async send(
    input: string,
    onUpdate: () => void,
    options: {
      webSearchEnabled?: boolean;
      model?: ChatModelId;
      attachments?: ChatImageAttachment[];
      approvedPlan?: ExecutionPlanData;
      planExecution?: PlanExecutionControlData;
    } = {},
  ) {
    const attachments = options.attachments ?? [];
    if ((!input.trim() && attachments.length === 0) || this.loading) return;

    this.loading = true;
    this.currentModel = options.model ?? null;
    this.manuallyAborted = false;
    this.error = null;
    let assistantMessageSaved = false;
    const userMessage: Message = { role: "user", content: input, attachments };
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
      const savedUserMessage = await this.sessionManager.saveUserMessage(this.id, input, {
        metadata: attachments.length > 0
          ? {
              attachments: attachments.map(toPersistedImageAttachment),
            }
          : undefined,
      });
      userMessage.id = savedUserMessage.id;
      userMessage.createdAt = savedUserMessage.created_at;
    } catch (error) {
      console.error("保存用户消息失败:", error);
      const imagePaths = attachments.flatMap((attachment) =>
        attachment.storagePath ? [attachment.storagePath] : []);
      if (imagePaths.length > 0) {
        await this.sessionManager.deleteChatImagePaths(imagePaths).catch((cleanupError) =>
          console.error("回滚未保存的图片失败:", cleanupError));
        this.messages = this.messages.filter((message) => message !== userMessage);
        this.error = error instanceof Error ? error.message : "保存图片消息失败";
        this.loading = false;
        onUpdate();
        return;
      }
    }

    if (this.messages.length === 1) {
      this.title = input.trim().slice(0, 20) || attachments[0]?.name.slice(0, 20) || "图片对话";
      // 更新数据库中的标题
      try {
        await this.sessionManager.updateSessionTitle(this.id, this.title);
      } catch (error) {
        console.error("更新标题失败:", error);
      }
    }

    this.messages.push({
      role: "assistant",
      content: "",
      plan: options.approvedPlan,
    });
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
          case "reasoning": {
            const reasoning = (last().reasoning ??= []);
            const current = reasoning.find(
              (item) => item.id === evt.reasoning.id,
            );
            if (current) current.content += evt.reasoning.content;
            else reasoning.push({ ...evt.reasoning });
            break;
          }
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
          case "plan_progress": {
            const planSteps = (last().planSteps ??= []);
            const existingIndex = planSteps.findIndex((step) => step.stepId === evt.plan.stepId);
            if (existingIndex >= 0) planSteps[existingIndex] = evt.plan;
            else planSteps.push(evt.plan);
            break;
          }
          case "plan_proposal":
            last().plan = evt.plan;
            break;
          case "plan_started":
            last().plan = evt.plan;
            last().planSteps = evt.plan.steps.map((step, stepIndex) => ({
              planId: evt.plan.id,
              stepId: step.id,
              goal: step.goal,
              status: "pending",
              stepIndex,
              stepCount: evt.plan.steps.length,
            }));
            break;
          case "error":
            throw new Error(evt.message || evt.error || "流式响应中断");
          case "done":
            last().content = sanitizeModelText(last().content);
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
          approvedPlan: options.approvedPlan,
          planExecution: options.planExecution,
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
            reasoning: lastMessage.reasoning,
            planSteps: lastMessage.planSteps,
            plan: lastMessage.plan,
          },
        },
      );
      lastMessage.id = save.id;
      lastMessage.createdAt = save.created_at;
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
