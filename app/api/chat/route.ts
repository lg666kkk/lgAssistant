import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import {
  ToolSourceType,
  runAgentLoop,
  enqueueSources,
  streamModelResponse,
  forwardTextStream,
} from "@/lib/agent/runtime";
import { enqueueEvent } from "@/lib/agent/runtime/events";
import { formatTraceTree } from "@/lib/agent/runtime/trace";
import { saveTrace } from "@/lib/agent/runtime/trace-store";
import { recallForPrompt, consolidate } from "@/lib/agent/memory/memory-flow";
import { RedisSessionStore } from "@/lib/agent/memory/session-store";
import { SessionManager } from "@/lib/session-manager";

// 单例：整个进程复用同一个 Redis 连接，不要每次请求都 new
const sessionStore = new RedisSessionStore();
const sessionManager = new SessionManager();

// Next.js App Router 的 API 路由，处理 POST /api/chat 请求
export async function POST(req: Request) {
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
  const { messages, sessionId, enableWebSearch } = body;

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
  // 有哪些工具
  const toolRegistry = createBuiltinToolRegistry();
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

      try {
        // ② 会话记忆：前端只传了一条消息时，从 Redis 补回历史
        // 前端传完整历史时（messages.length > 1）直接用，不覆盖
        let loopMessages = [...messages];
        if (sessionId && messages.length === 1) {
          try {
            const history = await sessionStore.getHistory(sessionId);
            if (history.length > 0) {
              // 把 Redis 里的历史拼在本轮消息前面
              loopMessages = [...history, ...messages];
            }
          } catch (e: any) {
            console.error("[session] 读取历史失败，跳过:", e.message);
          }
        }

        let allToolSources: ToolSourceType[] = [];

        // ① 召回：用最后一条 user 消息当 query，捞出相关记忆，拼成 system 注入
        const lastUser = [...messages]
          .reverse()
          .find((m: any) => m.role === "user");
        let memorySystem = "";
        if (lastUser) {
          try {
            memorySystem = await recallForPrompt(lastUser.content);
          } catch (e: any) {
            console.error("[memory] 召回失败，跳过注入:", e.message);
          }
        }
        const systemPrompt = [
          memorySystem,
          enableWebSearch
            ? "用户已开启联网搜索。本轮回答必须先调用 web_search 工具获取公开网页信息，再基于搜索结果作答；不要仅凭模型内部知识回答。"
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        // 异步写入 sessions 表，不阻塞响应（和 consolidate 同一模式）
        if (sessionId && systemPrompt) {
          void sessionManager
            .updateSystemPrompt(sessionId, systemPrompt)
            .catch((e: any) =>
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
        );
        console.log(
          "=== Agent Loop Trace ===",
          formatTraceTree(agentLoopResult.trace),
        );
        await saveTrace(agentLoopResult.trace)
        console.log("[AgentLoopMetrics]", agentLoopResult.metrics);
        loopMessages = agentLoopResult.loopMessages;

        // ③ 沉淀：后台异步抽取「值得长期记住的事实」并写回，不阻塞响应。
        void consolidate(messages, { sessionId }).catch((e: any) =>
          console.error("[consolidate] 失败:", e.message),
        );

        // ④ 会话记忆写入：await 确保写完再 return，否则 completed=true 时直接退出导致写入丢失
        if (sessionId) {
          try {
            const lastUser2 = [...messages].reverse().find((m: any) => m.role === "user");
            if (lastUser2) {
              await sessionStore.append(sessionId, { role: "user", content: lastUser2.content });
            }
            // 取最后一条有 text 内容的 assistant 消息（thinking 模式工具调用轮没有 text）
            const assistantText = [...agentLoopResult.loopMessages]
              .reverse()
              .reduce((found: string, m: any) => {
                if (found || m.role !== "assistant") return found;
                const text = Array.isArray(m.content)
                  ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                  : typeof m.content === "string" ? m.content : "";
                return text || found;
              }, "");
            if (assistantText) {
              await sessionStore.append(sessionId, { role: "assistant", content: assistantText });
            }
          } catch (e: any) {
            console.error("[session] 写入历史失败:", e.message);
          }
        }

        if (agentLoopResult.completed) {
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
        // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
        let stream;
        stream = await streamModelResponse(loopMessages, systemPrompt);
        // 遍历 API 推送的每个事件块（chunk）
        // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
        // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
        await forwardTextStream(
          stream,
          enqueueTextEvent,
          () => req.signal.aborted || closed,
        );

        if (req.signal.aborted || closed) {
          closeStream();
          return;
        }
        if (allToolSources.length > 0) {
          enqueueSources(allToolSources, enqueueText);
        }
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

  // 将 ReadableStream 包装成 HTTP 响应返回给前端
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",  // SSE 标准 MIME
      "Cache-Control": "no-cache",           // 禁止代理缓冲，保证流式实时推送
      "Connection": "keep-alive",
    },
  });
}
