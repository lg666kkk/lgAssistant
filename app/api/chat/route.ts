import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import {
  ToolSourceType,
  runAgentLoop,
  enqueueSources,
  streamModelResponse,
  forwardTextStream,
} from "@/lib/agent/runtime";
import { enqueueEvent } from "@/lib/agent/runtime/events";
import { saveTrace } from "@/lib/agent/runtime/trace-store";
import { recallForPrompt, consolidate } from "@/lib/agent/memory/memory-flow";
import { RedisSessionStore } from "@/lib/agent/memory/session-store";
import { resolveChatModel } from "@/lib/agent/models";
import { buildPromptPipe } from "@/lib/agent/prompt/pipe";
import { buildKnowledgeProfileForTool } from "@/lib/agent/tools/knowledge-profile";
import { requireUser } from "@/lib/auth/server";
import { getSupabase } from "@/lib/platform/supabase";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";

// 单例：整个进程复用同一个 Redis 连接，不要每次请求都 new
const sessionStore = new RedisSessionStore();
const SESSION_FALLBACK_MESSAGE_LIMIT = 15;

type SessionHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

function previewLoopMessages(messages: Array<{ role: string; content: unknown }>) {
  return messages.map((message, index) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);

    return {
      index,
      role: message.role,
      chars: content.length,
      preview: content.slice(0, 300),
    };
  });
}

async function persistSessionTurn(input: {
  userId: string;
  sessionId?: string;
  userMessage?: string;
  assistantMessage?: string;
}) {
  if (!input.sessionId) return;

  if (input.userMessage?.trim()) {
    await sessionStore.append(input.userId, input.sessionId, {
      role: "user",
      content: input.userMessage,
    });
  }

  if (input.assistantMessage?.trim()) {
    await sessionStore.append(input.userId, input.sessionId, {
      role: "assistant",
      content: input.assistantMessage,
    });
  }
}

function extractLastAssistantText(messages: unknown[]) {
  return [...messages]
    .reverse()
    .reduce((found: string, m: any) => {
      if (found || m.role !== "assistant") return found;
      const text = Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
        : typeof m.content === "string" ? m.content : "";
      return text || found;
    }, "");
}

function buildLangfuseTraceInput(input: {
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

async function restoreSessionHistoryFromDatabase(input: {
  userId: string;
  sessionId?: string;
}): Promise<SessionHistoryMessage[]> {
  if (!input.sessionId) return [];

  const { data, error } = await getSupabase()
    .from("messages")
    .select("role,content,created_at")
    .eq("user_id", input.userId)
    .eq("session_id", input.sessionId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(SESSION_FALLBACK_MESSAGE_LIMIT);

  if (error) {
    throw new Error(`从数据库恢复会话历史失败: ${error.message}`);
  }

  return (data ?? [])
    .reverse()
    .filter((message: any) => typeof message.content === "string")
    .map((message: any) => ({
      role: message.role as "user" | "assistant",
      content: message.content as string,
    }));
}

async function hydrateRedisSessionHistory(input: {
  userId: string;
  sessionId?: string;
  history: SessionHistoryMessage[];
}) {
  if (!input.sessionId || input.history.length === 0) return;

  await sessionStore.clear(input.userId, input.sessionId);
  for (const message of input.history) {
    await sessionStore.append(input.userId, input.sessionId, message);
  }
}

// Next.js App Router 的 API 路由，处理 POST /api/chat 请求
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  // 解析请求体
  let body;
  try {
    body = await req.json();
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "请求体格式错误，需要有效的 JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 校验 messages 字段
  const requestId = crypto.randomUUID();
  const { messages, sessionId } = body;
  const enableWebSearch = body.enableWebSearch !== false;
  const selectedModel = resolveChatModel(body.model);

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages 字段必须是非空数组" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 校验消息格式
  for (const msg of messages) {
    if (!msg.role || !msg.content || typeof msg.content !== "string") {
      return new Response(
        JSON.stringify({
          error: "消息格式错误，每条消息需要 role 和 content 字段",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!["user", "assistant"].includes(msg.role)) {
      return new Response(
        JSON.stringify({ error: "role 必须是 user 或 assistant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }
  const modelMessages = messages.map((msg: any) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));
  let knowledgeProfile: string | undefined;
  try {
    knowledgeProfile = await buildKnowledgeProfileForTool({ userId: user.id });
  } catch (error: any) {
    console.error("[knowledge] 构建工具画像失败，使用默认 search_notes 描述:", error.message);
  }
  // 有哪些工具
  const toolRegistry = createBuiltinToolRegistry({ knowledgeProfile });
  // 给模型看的工具说明
  const tools = toolRegistry
    .listForModel()
    .filter((tool) => enableWebSearch || tool.name !== "web_search");
  // 最大工具调用次数
  const maxToolIterations = 8;

  // TextEncoder 将字符串转为字节流（浏览器接收的是字节，不是字符串）
  const encoder = new TextEncoder();

  // 构建 Web 标准的 ReadableStream，将 API 的流式事件转发给浏览器
  const readable = new ReadableStream({
    async start(controller) {
      let closed = false;
      const enqueueText = (text: string) => {
        if (closed || req.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch (error: any) {
          if (error?.code !== "ERR_INVALID_STATE") {
            console.error("[Stream] 写入响应失败:", error);
          }
          closed = true;
          return false;
        }
      };
      const closeStream = () => {
        if (closed) return;
        try {
          controller.close();
        } catch (error: any) {
          if (error?.code !== "ERR_INVALID_STATE") {
            console.error("[Stream] 关闭响应失败:", error);
          }
        } finally {
          closed = true;
        }
      };

      await startActiveObservation("agent-chat", async (langfuseTrace) => {
        const traceInput = buildLangfuseTraceInput({
          requestId,
          sessionId,
          userId: user.id,
          model: selectedModel,
          messages: modelMessages,
        });
        const traceDisplayInput = traceInput.query || "(空消息)";
        langfuseTrace.update({
          input: traceDisplayInput,
          metadata: {
            requestId,
            sessionId,
            userId: user.id,
            model: selectedModel,
            traceInput,
          },
        });
        langfuseTrace.setTraceIO({ input: traceDisplayInput });

        await propagateAttributes({
          userId: user.id,
          sessionId,
          traceName: "agent-chat",
          tags: ["api-chat", "agent"],
          metadata: {
            requestId,
            model: selectedModel,
          },
        }, async () => {
      try {
        // ② 会话记忆：前端只传了一条消息时，从 Redis 补回历史
        // 前端传完整历史时（messages.length > 1）直接用，不覆盖
        let loopMessages = [...modelMessages];
        if (sessionId && messages.length === 1) {
          try {
            let history = await sessionStore.getHistory(user.id, sessionId);
            if (history.length === 0) {
              const restoredHistory = await restoreSessionHistoryFromDatabase({
                userId: user.id,
                sessionId,
              });
              if (restoredHistory.length > 0) {
                const currentUserContent = modelMessages[0]?.content;
                history = restoredHistory.filter(
                  (message, index) =>
                    !(
                      index === restoredHistory.length - 1 &&
                      message.role === "user" &&
                      message.content === currentUserContent
                    ),
                );
                await hydrateRedisSessionHistory({
                  userId: user.id,
                  sessionId,
                  history,
                });
              }
            }
            if (history.length > 0) {
              // 把 Redis 里的历史拼在本轮消息前面
              loopMessages = [
                ...history.slice(-SESSION_FALLBACK_MESSAGE_LIMIT),
                ...modelMessages,
              ];
            }
          } catch (e: any) {
            console.error("[session] 读取历史失败，跳过:", e.message);
          }
        }

        console.log("[chat] loopMessages 实际发送给 Agent:", previewLoopMessages(loopMessages));

        let allToolSources: ToolSourceType[] = [];

        // ① 召回：用最后一条 user 消息当 query，捞出相关记忆，拼成 system 注入
        const lastUser = [...messages]
          .reverse()
          .find((m: any) => m.role === "user");
        let memorySystem = "";
        if (lastUser) {
          try {
            memorySystem = await recallForPrompt(lastUser.content, { userId: user.id });
          } catch (e: any) {
            console.error("[memory] 召回失败，跳过注入:", e.message);
          }
        }
        // Prompt Pipe：构造段 → 排序 → 预算裁剪 → 渲染 system prompt。
        // segments 同时透传给 loop 写进 trace，供详情页按段展示。
        const prompt = buildPromptPipe({
          userMessage: lastUser?.content ?? "",
          memory: memorySystem,
          webSearchEnabled: enableWebSearch,
          currentDate: new Date().toISOString(),
          maxTokens: 4200,
        });
        const systemPrompt = prompt.systemPrompt;
        const systemSegments = prompt.segments;

        // 异步写入 sessions 表，不阻塞响应（和 consolidate 同一模式）
        if (sessionId && systemPrompt) {
          void (async () => {
            const { error: updateError } = await getSupabase()
              .from("sessions")
              .update({ system_prompt: systemPrompt })
              .eq("id", sessionId)
              .eq("user_id", user.id);

            if (updateError) throw updateError;
          })().catch((e: any) =>
            console.error("[memory] system_prompt 写入失败:", e.message),
          );
        }

        const agentLoopResult = await runAgentLoop(
          loopMessages,
          tools,
          toolRegistry,
          maxToolIterations,
          allToolSources,
          enqueueText,
          requestId,
          sessionId,
          undefined, // deps 用默认
          systemPrompt, // ② 注入召回的记忆和联网搜索策略
          () => req.signal.aborted || closed,
          selectedModel,
          systemSegments, // 段化结构，写进 trace 供详情页按段展示
          user.id,
        );
        void saveTrace(agentLoopResult.trace, user.id).catch((e: any) =>
          console.error("[trace] 保存失败，跳过:", e.message),
        );
        loopMessages = agentLoopResult.loopMessages;

        // ③ 沉淀：后台异步抽取「值得长期记住的事实」并写回，不阻塞响应。
        void consolidate(modelMessages, { sessionId, userId: user.id }).catch((e: any) =>
          console.error("[consolidate] 失败:", e.message),
        );

        const lastUserMessage = [...messages].reverse().find((m: any) => m.role === "user")?.content;

        if (agentLoopResult.completed) {
          const assistantMessage = extractLastAssistantText(agentLoopResult.loopMessages);
          langfuseTrace.update({
            output: {
              completed: true,
              stopReason: agentLoopResult.stopReason,
              assistantMessage,
            },
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: assistantMessage,
          });
          void persistSessionTurn({
            userId: user.id,
            sessionId,
            userMessage: lastUserMessage,
            assistantMessage,
          }).catch((e: any) =>
            console.error("[session] 写入历史失败:", e.message),
          );
          enqueueEvent({ type: "done" }, enqueueText);
          closeStream();
          return;
        }
        // 适配器：把第二阶段的纯文本统一包成 text 事件再写流，
        // 这样 forwardTextStream 本身一行不用改（签名仍是 (string)=>boolean）
        const enqueueTextEvent = (t: string) =>
          enqueueEvent({ type: "text", content: t }, enqueueText);
        if (agentLoopResult.stopReason === "max_iterations") {
          enqueueTextEvent("\n\n工具调用轮数已达到上限，我会基于当前结果总结。\n\n");
        } else if (agentLoopResult.stopReason === "repeated_tool_call") {
          enqueueTextEvent("\n\n检测到重复工具调用，我会基于当前结果总结。\n\n");
        }
        let finalAssistantText = "";
        // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
        let stream;
        stream = await streamModelResponse(loopMessages, systemPrompt, selectedModel, {
          operation: "final-answer",
          requestId,
          sessionId,
          userId: user.id,
          messageCount: loopMessages.length,
        });
        // 遍历 API 推送的每个事件块（chunk）
        // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
        // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
        const finalStopReason = await forwardTextStream(
          stream,
          (text) => {
            finalAssistantText += text;
            return enqueueTextEvent(text);
          },
          () => req.signal.aborted || closed,
        );

        if (req.signal.aborted || closed) {
          langfuseTrace.update({
            output: {
              completed: false,
              stopReason: "aborted",
              assistantMessage: finalAssistantText,
            },
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: finalAssistantText,
          });
          closeStream();
          return;
        }
        if (allToolSources.length > 0) {
          enqueueSources(allToolSources, enqueueText);
        }
        if (finalStopReason === "max_tokens") {
          const maxTokenNotice = "\n\n（输出达到模型单次回复上限，内容可能未完整生成。）";
          finalAssistantText += maxTokenNotice;
          enqueueTextEvent(maxTokenNotice);
        }
        void persistSessionTurn({
          userId: user.id,
          sessionId,
          userMessage: lastUserMessage,
          assistantMessage: finalAssistantText,
        }).catch((e: any) =>
          console.error("[session] 写入历史失败:", e.message),
        );
        langfuseTrace.update({
          output: {
            completed: true,
            stopReason: finalStopReason ?? "end_turn",
            assistantMessage: finalAssistantText,
          },
        });
        langfuseTrace.setTraceIO({
          input: traceDisplayInput,
          output: finalAssistantText,
        });
        // 所有事件处理完毕，发 done 事件后关闭流，告诉浏览器"传输结束"
        enqueueEvent({ type: "done" }, enqueueText);
        closeStream();
      } catch (error: any) {
        if (req.signal.aborted || closed) {
          langfuseTrace.update({
            output: {
              completed: false,
              stopReason: "aborted",
              error: error.message || "未知错误",
            },
            level: "WARNING",
          });
          langfuseTrace.setTraceIO({
            input: traceDisplayInput,
            output: {
              error: error.message || "未知错误",
              aborted: true,
            },
          });
          closeStream();
          return;
        }
        // 发送 error 事件（替代 __ERROR__ marker）
        enqueueEvent(
          {
            type: "error",
            error: "流式响应中断",
            message: error.message || "未知错误",
          },
          enqueueText,
        );
        langfuseTrace.update({
          output: {
            completed: false,
            stopReason: "error",
            error: error.message || "未知错误",
          },
          level: "ERROR",
          statusMessage: error.message || "未知错误",
        });
        langfuseTrace.setTraceIO({
          input: traceDisplayInput,
          output: {
            error: error.message || "未知错误",
          },
        });
        closeStream();
      }
        });
      }, { asType: "agent" });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
