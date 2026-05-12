import Anthropic from '@anthropic-ai/sdk';
import { RAGRetriever } from '@/lib/server/retriever';

// 创建 Anthropic 客户端，从环境变量读取 API Key 和中转站地址
const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
})

// Next.js App Router 的 API 路由，处理 POST /api/chat 请求
export async function POST(req: Request) {
    // 从请求体中提取消息列表，格式: [{ role: 'user', content: '你好' }, ...]
    const { messages } = await  req.json()

    // RAG 检索：获取用户最后一条消息
    const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
    let ragContext = '';

    console.log('[RAG] 开始检索，用户问题:', lastUserMessage?.content);

    if (lastUserMessage) {
        try {
            const retriever = new RAGRetriever();
            const results = await retriever.search(lastUserMessage.content, {
                matchThreshold: 0.5,
                matchCount: 3,
            });

            console.log(`[RAG] 检索结果数量: ${results.length}`);

            if (results.length > 0) {
                ragContext = retriever.formatContext(results);
                console.log(`[RAG] 找到 ${results.length} 个相关文档`);
                console.log('[RAG] 上下文长度:', ragContext.length);
            } else {
                console.log('[RAG] 未找到相关文档');
            }
        } catch (error) {
            console.error('[RAG] 检索失败:', error);
            // 检索失败不影响正常对话，继续执行
        }
    }

    // 如果有 RAG 上下文，注入到消息中
    const enhancedMessages = ragContext
        ? [
            {
                role: 'user',
                content: `# 知识库参考资料

${ragContext}

---

# 用户问题
${lastUserMessage.content}

# 回答要求
1. **优先使用上述知识库内容回答**
2. 如果知识库中有相关信息，请直接引用并说明来源
3. 如果知识库中没有相关信息，可以使用你的通用知识回答，但请说明这不是来自知识库`,
            },
            ...messages.slice(0, -1), // 保留历史消息（除了最后一条）
        ]
        : messages;

    console.log('[RAG] 是否注入:', !!ragContext);
    console.log('[RAG] 最终消息数量:', enhancedMessages.length);
    if (ragContext) {
        console.log('[RAG] 发送给 LLM 的完整消息:', JSON.stringify(enhancedMessages[0], null, 2));
    }

    // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
    const stream = await client.messages.create({
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: enhancedMessages,
        stream: true,
    })

    // TextEncoder 将字符串转为字节流（浏览器接收的是字节，不是字符串）
    const encoder = new TextEncoder();

    // 构建 Web 标准的 ReadableStream，将 API 的流式事件转发给浏览器
    const readable = new ReadableStream({
        async start(controller) {
            // 遍历 API 推送的每个事件块（chunk）
            // Anthropic 流会推送多种事件类型：message_start, content_block_delta, message_stop 等
            // 我们只关心 content_block_delta + text_delta，那才是实际的文字内容
            for await (const chunk of stream) {
                if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                    const text = chunk.delta.text;
                    if (text) {
                        // 将文字编码后推入流中，浏览器会实时接收到这段文字
                        controller.enqueue(encoder.encode(text));
                    }
                }
            }
            // 所有事件处理完毕，关闭流，告诉浏览器"传输结束"
            controller.close();
        }
    })

    // 将 ReadableStream 包装成 HTTP 响应返回给前端
    return new Response(readable, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
}