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
import { requireUser } from "@/lib/auth/server";
import { getSupabase } from "@/lib/supabase";
import { ragConfig } from "@/lib/config";
import { RAGRetriever, type RAGSearchResponse } from "@/lib/server/retriever";

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

function shouldAutoSearchKnowledge(query: string) {
  const text = query.trim();
  if (!text) return false;

  const skipPatterns = [
    /^(你好|hello|hi|嗨|谢谢|thanks|ok|好的|嗯|哈哈)/i,
    /(现在几点|今天几号|当前时间|天气|新闻|最新|价格|汇率|股价)/,
    /(翻译|润色|改写|生成|写一段|帮我写|总结这段|解释这段)/,
    /(计算|算一下|\d+\s*[\+\-\*\/×÷]\s*\d+)/,
    /(创建|新建|增加|添加|设置|设定|安排).{0,12}(定时|定时器|任务|提醒|cron|闹钟)/i,
    /(定时|定时器|cron).{0,20}(提醒|推送|发送|执行|运行|跑)/i,
    /(每天|每周|每月|明天|后天|今晚|早上|上午|下午|晚上).{0,20}(提醒|推送|发送|执行|运行|跑)/,
  ];

  // 用户显式开启「知识库搜索」即代表优先从知识库查找：除寒暄、实时类、
  // 纯文本改写、算术这类明显无需检索的输入外，一律尝试自动检索。
  return !skipPatterns.some((pattern) => pattern.test(text));
}

function buildRagTraceAttempt(input: {
  label: string;
  threshold: number;
  response: RAGSearchResponse;
}) {
  return {
    label: input.label,
    threshold: input.threshold,
    debug: input.response.debug,
    topResults: input.response.results.slice(0, 5).map((result, index) => ({
      rank: index + 1,
      id: result.id,
      pageId: result.pageId,
      pageTitle: result.pageTitle,
      pageUrl: result.pageUrl,
      similarity: result.similarity,
      vectorScore: result.vectorScore,
      keywordScore: result.keywordScore,
      rerankScore: result.rerankScore ?? result.combinedScore,
      retrievalSources: result.retrievalSources,
      headingPath: result.headingPath,
      excerpt: result.content.replace(/\s+/g, " ").trim().slice(0, 240),
    })),
  };
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
  const enableKnowledgeSearch = body.enableKnowledgeSearch !== false;
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
  // 有哪些工具
  const toolRegistry = createBuiltinToolRegistry();
  // 给模型看的工具说明
  const tools = toolRegistry
    .listForModel()
    .filter((tool) => enableWebSearch || tool.name !== "web_search")
    .filter((tool) => enableKnowledgeSearch || tool.name !== "search_notes");
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
        let knowledgeSystem = "";
        let knowledgeMetadata: Record<string, unknown> | undefined;
        if (lastUser) {
          try {
            memorySystem = await recallForPrompt(lastUser.content, { userId: user.id });
          } catch (e: any) {
            console.error("[memory] 召回失败，跳过注入:", e.message);
          }

          if (enableKnowledgeSearch && shouldAutoSearchKnowledge(lastUser.content)) {
            try {
              const retriever = new RAGRetriever();
              const ragStartedAt = Date.now();
              const attempts: Array<ReturnType<typeof buildRagTraceAttempt>> = [];
              let knowledgeResponse = await retriever.searchWithDebug(
                lastUser.content,
                {
                  matchThreshold: ragConfig.similarityThreshold,
                  matchCount: ragConfig.maxResults,
                  userId: user.id,
                  enableMmr: true,
                  enableQueryRewrite: true,
                  enableRerank: true,
                },
              );
              attempts.push(
                buildRagTraceAttempt({
                  label: "primary",
                  threshold: ragConfig.similarityThreshold,
                  response: knowledgeResponse,
                }),
              );

              if (knowledgeResponse.results.length === 0) {
                knowledgeResponse = await retriever.searchWithDebug(lastUser.content, {
                  matchThreshold: 0,
                  matchCount: ragConfig.maxResults,
                  userId: user.id,
                  enableMmr: true,
                  enableQueryRewrite: true,
                  enableRerank: true,
                });
                attempts.push(
                  buildRagTraceAttempt({
                    label: "fallback_threshold_0",
                    threshold: 0,
                    response: knowledgeResponse,
                  }),
                );
              }

              knowledgeMetadata = {
                type: "rag_auto_knowledge",
                query: lastUser.content,
                triggered: true,
                usedFallback: attempts.length > 1,
                durationMs: Date.now() - ragStartedAt,
                finalReturnedCount: knowledgeResponse.results.length,
                attempts,
              };

              if (knowledgeResponse.results.length > 0) {
                allToolSources.push(
                  ...knowledgeResponse.results.map((result) => ({
                    title: result.pageTitle,
                    notionPageId: result.pageId,
                    pageUrl: result.pageUrl,
                    similarity: result.rerankScore ?? result.combinedScore,
                    excerpt: result.content.substring(0, 180),
                  })),
                );
                knowledgeSystem = [
                  "以下是从用户个人知识库自动检索到的资料。回答和这些资料相关的问题时，优先基于这里的内容；如果资料不足，请说明不足，不要硬编。",
                  "",
                  retriever.formatContext(knowledgeResponse.results),
                ].join("\n");
              }
            } catch (e: any) {
              console.error("[knowledge] 自动检索失败，跳过注入:", e.message);
              knowledgeMetadata = {
                type: "rag_auto_knowledge",
                query: lastUser.content,
                triggered: true,
                error: e.message,
              };
            }
          }
        }
        // Prompt Pipe：构造段 → 排序 → 预算裁剪 → 渲染 system prompt。
        // segments 同时透传给 loop 写进 trace，供详情页按段展示。
        const prompt = buildPromptPipe({
          userMessage: lastUser?.content ?? "",
          memory: memorySystem,
          knowledge: knowledgeSystem,
          knowledgeMetadata,
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
          void persistSessionTurn({
            userId: user.id,
            sessionId,
            userMessage: lastUserMessage,
            assistantMessage: extractLastAssistantText(agentLoopResult.loopMessages),
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
        stream = await streamModelResponse(loopMessages, systemPrompt, selectedModel);
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
        // 所有事件处理完毕，发 done 事件后关闭流，告诉浏览器"传输结束"
        enqueueEvent({ type: "done" }, enqueueText);
        closeStream();
      } catch (error: any) {
        if (req.signal.aborted || closed) {
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
        closeStream();
      }
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
