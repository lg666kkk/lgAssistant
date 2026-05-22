# 00 — 流式对话

## 这个功能解决什么问题

让用户和 AI 对话时，回答逐字出现（而不是等全部生成完再一次性显示），体验类似 ChatGPT。

## 核心概念

### Streaming（流式响应）

传统 HTTP 请求是"请求 → 等待 → 一次性返回完整响应"。流式响应是"请求 → 服务端边生成边推送 → 客户端边接收边渲染"。

LLM 生成文本是逐 token 的，如果等全部生成完再返回，用户可能要等 10-30 秒看到一片空白。流式传输让第一个字在几百毫秒内就能出现。

### Anthropic Streaming 事件类型

Anthropic SDK 的 `stream: true` 模式会推送多种事件：

```
message_start        → 消息开始
content_block_start  → 内容块开始
content_block_delta  → 实际的文字增量（我们只关心这个）
content_block_stop   → 内容块结束
message_stop         → 消息结束
```

我们只需要从 `content_block_delta` 中提取 `text_delta.text`，其他事件可以忽略。

### ReadableStream（Web Streams API）

浏览器原生的流式数据处理 API。服务端创建一个 `ReadableStream`，往里面 `enqueue` 数据块，浏览器通过 `getReader().read()` 逐块读取。

关键点：浏览器接收的是字节（Uint8Array），不是字符串，所以需要：
- 服务端：`TextEncoder` 将字符串编码为字节
- 客户端：`TextDecoder` 将字节解码为字符串

### Next.js App Router 的 API 路由

App Router 中 `app/api/chat/route.ts` 导出 `POST` 函数即可处理 POST 请求。返回 `new Response(readableStream)` 就能实现流式响应 — 不需要额外配置。

## 工程实现

### 整体流程

```
用户输入 → 前端 fetch POST /api/chat → 后端调 Anthropic API (stream:true)
         → 遍历事件流，提取文字 → 推入 ReadableStream
         → 前端 reader.read() 逐块接收 → 拼接到消息内容 → 触发重渲染
```

### 关键代码走读

**后端** `app/api/chat/route.ts`：

```typescript
// 关键1：stream: true 启用流式模式
const stream = await client.messages.create({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages,
    stream: true,
})

// 关键2：用 ReadableStream 桥接 Anthropic 流和 HTTP 响应
const readable = new ReadableStream({
    async start(controller) {
        for await (const chunk of stream) {
            // 关键3：只关心 content_block_delta + text_delta
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                controller.enqueue(encoder.encode(chunk.delta.text));
            }
        }
        controller.close();
    }
})
```

**前端** `lib/chat-session.ts`：

```typescript
// 关键4：用 reader 逐块读取流式响应
const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // 关键5：每收到一块就拼接到消息内容并触发重渲染
    this.messages[this.messages.length - 1].content += decoder.decode(value);
    onUpdate();
}
```

### 技术选型与决策

**为什么用 ReadableStream 而不是 SSE（Server-Sent Events）？**

SSE 是更常见的流式推送方案，但这里用 ReadableStream 更简单：
- 我们只需要纯文本流，不需要 SSE 的事件类型、ID、重连机制
- ReadableStream 不需要 `EventSource` 客户端，直接 `fetch` + `getReader` 就行
- 后续如果需要推送结构化数据（tool_use 事件），再升级为 SSE 或 JSON stream

**为什么响应头是 `text/plain` 而不是 `text/event-stream`？**

因为当前是纯文本流，不是 SSE 格式。用 `text/plain` 更准确。

## 踩坑记录

### 多会话状态管理

React 的 `useState` 存数组时，修改数组内对象的属性不会触发重渲染（引用没变）。解法是用 `useRef` 存会话列表 + 手动 `forceUpdate`：

```typescript
const sessionsRef = useRef<ChatSession[]>([new ChatSession()]);
const [, forceUpdate] = useState(0);
const rerender = useCallback(() => forceUpdate((n) => n + 1), []);
```

这样 `ChatSession` 实例可以自由修改内部状态（messages、loading 等），通过 `onUpdate` 回调通知 React 重渲染。

### AbortController 用于取消请求

用户切换会话或删除会话时，需要中断正在进行的流式请求，否则旧请求的数据会继续写入已删除的会话：

```typescript
this.abortController = new AbortController();
const response = await fetch("/api/chat", {
    signal: this.abortController.signal,
});
```

## 延伸阅读

- [Anthropic Streaming 文档](https://docs.anthropic.com/en/api/streaming)
- [MDN ReadableStream](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)
- [MDN TextEncoder / TextDecoder](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder)
- [Next.js Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
