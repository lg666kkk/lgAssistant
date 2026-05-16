import Anthropic from "@anthropic-ai/sdk";
import { RAGRetriever } from "@/lib/server/retriever";
import { deepseekConfig, ragConfig } from "@/lib/config";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { executeToolCall } from "@/lib/agent/tools/tool-router";

// 创建 Anthropic 客户端，从配置读取
const client = new Anthropic({
  apiKey: deepseekConfig.apiKey,
  baseURL: deepseekConfig.baseURL,
});

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
  const { messages } = body;
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

  // RAG 检索：获取用户最后一条消息
  const lastUserMessage = messages.filter((m: any) => m.role === "user").pop();
  let ragContext = "";
  let ragResults: any[] = [];

  console.log("[RAG] 开始检索，用户问题:", lastUserMessage?.content);

  if (lastUserMessage) {
    try {
      const retriever = new RAGRetriever();
      ragResults = await retriever.search(lastUserMessage.content, {
        matchThreshold: ragConfig.similarityThreshold,
        matchCount: ragConfig.maxResults,
      });

      if (ragResults.length > 0) {
        ragContext = retriever.formatContext(ragResults);
      } else {
        console.log("[RAG] 未找到相关文档");
      }
    } catch (error) {
      console.error("[RAG] 检索失败:", error);
      // 检索失败不影响正常对话，继续执行
    }
  }

  // 如果有 RAG 上下文，注入到消息中
  const enhancedMessages = ragContext
    ? [
        {
          role: "user",
          content: `${ragContext}

---

${lastUserMessage.content}`,
        },
        ...messages.slice(0, -1), // 保留历史消息（除了最后一条）
      ]
    : messages;

  const toolRegistry = createBuiltinToolRegistry();
  const tools = toolRegistry.listForModel();
  // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
  let initialResponse;
  let stream;
  try {
    initialResponse = await client.messages.create({
      model: deepseekConfig.model,
      max_tokens: deepseekConfig.maxTokens,
      messages: enhancedMessages,
      //   stream: true,
      tools,
    });
  } catch (error: any) {
    console.error("[LLM] 调用失败:", error);
    return new Response(
      JSON.stringify({
        error: "模型调用失败",
        message: error.message || "未知错误",
        code: error.status || 500,
      }),
      {
        status: error.status || 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  const toolUses = initialResponse.content.filter(
    (block) => block.type === "tool_use",
  );
  const toolUse = toolUses[0];
  const directText = initialResponse.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

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
        if (!toolUse) {
          // 直接返回文本
          if (directText) {
            enqueueText(directText);
          }
          closeStream();
          return;
        }
        // 给模型用，作为 Anthropic tool_result 消息
        const toolResultBlocks: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error: boolean;
        }> = [];
        for (let toolUse of toolUses) {
          const toolResult = await executeToolCall(toolRegistry, {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });
          // 放入单工具执行结果
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: toolResult.content,
            is_error: !toolResult.ok,
          });
          const toolMarker =
            "\n\n__TOOL_CALL__\n" +
            JSON.stringify({
              name: toolUse.name,
              input: toolUse.input,
              ok: toolResult.ok,
              content: toolResult.content,
              error: toolResult.error,
            }) +
            "\n__END_TOOL_CALL__\n";

          enqueueText(toolMarker);
        }
        stream = await client.messages.create({
          model: deepseekConfig.model,
          max_tokens: deepseekConfig.maxTokens,
          messages: [
            ...enhancedMessages,
            {
              role: "assistant",
              content: initialResponse.content,
            },
            {
              role: "user",
              content: toolResultBlocks,
            },
          ],
          stream: true,
        });
        // 遍历 API 推送的每个事件块（chunk）
        // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
        // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
        for await (const chunk of stream) {
          if (req.signal.aborted || closed) {
            break;
          }
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            const text = chunk.delta.text;
            if (text) {
              // 将文字编码后推入流中，浏览器会实时接收到这段文字
              if (!enqueueText(text)) {
                break;
              }
            }
          }
        }

        if (req.signal.aborted || closed) {
          closeStream();
          return;
        }

        // 流式响应结束后，附加引用来源信息
        if (ragResults.length > 0) {
          // 按页面去重，保留每个页面相似度最高的 chunk
          const uniquePages = new Map<string, (typeof ragResults)[0]>();
          for (const doc of ragResults) {
            const existing = uniquePages.get(doc.pageId);
            if (!existing || doc.similarity > existing.similarity) {
              uniquePages.set(doc.pageId, doc);
            }
          }

          const sources = Array.from(uniquePages.values()).map((doc) => ({
            title: doc.pageTitle,
            notionPageId: doc.pageId,
            pageUrl: doc.pageUrl,
            similarity: doc.similarity,
            excerpt: doc.content.substring(0, 100),
          }));

          // 使用特殊分隔符标记来源数据
          const sourcesMarker = "\n\n__SOURCES__\n" + JSON.stringify(sources);
          enqueueText(sourcesMarker);
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
