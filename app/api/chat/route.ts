import Anthropic from '@anthropic-ai/sdk';

// 创建 Anthropic 客户端，从环境变量读取 API Key 和中转站地址
const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
})

// Next.js App Router 的 API 路由，处理 POST /api/chat 请求
export async function POST(req: Request) {
    // 从请求体中提取消息列表，格式: [{ role: 'user', content: '你好' }, ...]
    const { messages } = await  req.json()

    // 调用 LLM API，stream: true 表示启用流式响应（逐块返回，而非等全部生成完）
    const stream = await client.messages.create({
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages,
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