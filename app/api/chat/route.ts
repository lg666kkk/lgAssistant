import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import {
  ToolSourceType,
  runAgentLoop,
  enqueueSources,
  streamModelResponse,
  forwardTextStream,
} from "@/lib/agent/runtime";
import { formatTraceTree } from "@/lib/agent/runtime/trace";
import { saveTrace } from "@/lib/agent/runtime/trace-store";
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
  const { messages, sessionId } = body;

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
  const tools = toolRegistry.listForModel();
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
        let loopMessages = [...messages];
        let allToolSources: ToolSourceType[] = [];
        const agentLoopResult = await runAgentLoop(
          loopMessages,
          tools,
          toolRegistry,
          maxToolIterations,
          allToolSources,
          enqueueText,
          requestId,
          sessionId
        );
        console.log(
          "=== Agent Loop Trace ===",
          formatTraceTree(agentLoopResult.trace),
        );
        await saveTrace(agentLoopResult.trace)
        console.log("[AgentLoopMetrics]", agentLoopResult.metrics);
        loopMessages = agentLoopResult.loopMessages;
        if (agentLoopResult.completed) {
          closeStream();
          return;
        }
        if (agentLoopResult.stopReason === "max_iterations") {
          enqueueText("\n\n工具调用轮数已达到上限，我会基于当前结果总结。\n\n");
        } else if (agentLoopResult.stopReason === "repeated_tool_call") {
          enqueueText("\n\n检测到重复工具调用，我会基于当前结果总结。\n\n");
        }
        // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
        let stream;
        stream = await streamModelResponse(loopMessages);
        // 遍历 API 推送的每个事件块（chunk）
        // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
        // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
        await forwardTextStream(
          stream,
          enqueueText,
          () => req.signal.aborted || closed,
        );

        if (req.signal.aborted || closed) {
          closeStream();
          return;
        }
        if (allToolSources.length > 0) {
          enqueueSources(allToolSources, enqueueText);
        }
        // 所有事件处理完毕，关闭流，告诉浏览器"传输结束"
        closeStream();
      } catch (error: any) {
        if (req.signal.aborted || closed) {
          closeStream();
          return;
        }
        // 发送错误标记
        const errorMarker =
          "\n\n__ERROR__\n" +
          JSON.stringify({
            error: "流式响应中断",
            message: error.message || "未知错误",
          });
        enqueueText(errorMarker);
        closeStream();
      }
    },
  });

  // 将 ReadableStream 包装成 HTTP 响应返回给前端
  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
