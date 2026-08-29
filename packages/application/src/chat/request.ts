import type Anthropic from "@anthropic-ai/sdk";
import {
  buildMultimodalUserContent,
  validateImageAttachments,
} from "@/lib/agent/multimodal";
import type { ChatUserContextPort } from "./ports";

type ModelMessage = Anthropic.MessageParam;
type ResolveModel = ChatUserContextPort["resolveModel"];
type RuntimeModel = Awaited<ReturnType<ResolveModel>>;

export type ChatRequestBody = Record<string, any> & {
  messages: unknown[];
  sessionId?: string;
  enableWebSearch?: boolean;
  model?: string;
};

export type ParsedChatRequest = {
  body: ChatRequestBody;
  requestId: string;
  requestReceivedAt: string;
  sessionId?: string;
  enableWebSearch: boolean;
  selectedRuntimeModel: RuntimeModel;
  selectedModel: string;
  requestMessages: Array<{
    role: "user" | "assistant";
    content: string;
    attachments: ReturnType<typeof validateImageAttachments>["attachments"];
  }>;
  modelMessages: ModelMessage[];
  requestTextMessages: Array<{ role: "user" | "assistant"; content: string }>;
};

export type ParseChatRequestResult =
  | { ok: true; value: ParsedChatRequest }
  | { ok: false; response: Response };

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function parseChatRequest(
  request: Request,
  userId: string,
  resolveModel: ResolveModel,
): Promise<ParseChatRequestResult> {
  let body: ChatRequestBody;
  try {
    body = await request.json() as ChatRequestBody;
  } catch {
    return { ok: false, response: jsonError("请求体格式错误，需要有效的 JSON") };
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, response: jsonError("messages 字段必须是非空数组") };
  }

  let selectedRuntimeModel: RuntimeModel;
  try {
    selectedRuntimeModel = await resolveModel(
      userId,
      typeof body.model === "string" ? body.model : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      response: jsonError(error instanceof Error ? error.message : "无法解析用户模型配置"),
    };
  }

  const requestMessages: ParsedChatRequest["requestMessages"] = [];
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object") {
      return { ok: false, response: jsonError("消息格式错误，每条消息需要 role 和 content 字段") };
    }
    const message = rawMessage as Record<string, unknown>;
    if (typeof message.role !== "string" || typeof message.content !== "string") {
      return { ok: false, response: jsonError("消息格式错误，每条消息需要 role 和 content 字段") };
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return { ok: false, response: jsonError("role 必须是 user 或 assistant") };
    }
    const attachmentResult = validateImageAttachments(message.attachments);
    if (attachmentResult.error) {
      return { ok: false, response: jsonError(attachmentResult.error) };
    }
    if (message.role !== "user" && attachmentResult.attachments.length > 0) {
      return { ok: false, response: jsonError("图片附件只能放在 user 消息中") };
    }
    if (!message.content.trim() && attachmentResult.attachments.length === 0) {
      return { ok: false, response: jsonError("消息内容和图片附件不能同时为空") };
    }
    requestMessages.push({
      role: message.role,
      content: message.content,
      attachments: attachmentResult.attachments,
    });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (sessionId && (messages.length !== 1 || requestMessages[0].role !== "user")) {
    return { ok: false, response: jsonError("会话请求只能提交一条当前用户消息") };
  }

  const hasImageAttachments = requestMessages.some((message) => message.attachments.length > 0);
  if (hasImageAttachments && !selectedRuntimeModel.supportsImages) {
    return {
      ok: false,
      response: jsonError("当前模型未启用图片输入能力，请选择视觉模型"),
    };
  }

  const modelMessages = requestMessages.map((message) => ({
    role: message.role,
    content: message.role === "user"
      ? buildMultimodalUserContent(message.content, message.attachments)
      : message.content,
  })) as ModelMessage[];

  return {
    ok: true,
    value: {
      body,
      requestId: crypto.randomUUID(),
      requestReceivedAt: new Date().toISOString(),
      sessionId,
      enableWebSearch: body.enableWebSearch !== false,
      selectedRuntimeModel,
      selectedModel: selectedRuntimeModel.id,
      requestMessages,
      modelMessages,
      requestTextMessages: requestMessages.map(({ role, content }) => ({ role, content })),
    },
  };
}
