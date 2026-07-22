# 结构化事件协议（能力 4）

> 当前建设优先级见 [企业级 Agent 路线图](./enterprise-agent-roadmap.md)。
> 从文本 marker 协议升级为 SSE 事件流。

## 这个功能解决什么问题

原协议把结构化数据（工具调用、来源、错误）当**文本 marker** 塞进同一条 ReadableStream：

```
后端拼：\n\n__TOOL_CALL__\n{json}\n__END_TOOL_CALL__\n
前端切：fullText.indexOf("__TOOL_CALL__") + substring + while 循环
```

三个真实毛病：
1. **污染**：模型若输出 `__TOOL_CALL__` 字面量 → 被当成真 marker，解析错乱
2. **脆弱**：`indexOf` + `substring` 手工切三种 marker 的 while 循环难维护、难扩展
3. **切错**：文本 + 结构化数据混在一条流，JSON 里有换行就可能被 marker 切错

升级目标：**SSE 事件流** —— 每个事件有明确 `event:` 类型行，前端通过 `fetchEventSource` 库回调接收，彻底告别字符串切割。

## 核心概念

### 1. NDJSON（起点，已被 SSE 替代，但概念相同）

一个 JSON 对象一行，`\n` 分隔。`JSON.stringify` 会把字符串内部的真实换行转义成 `\\n`，所以**一个事件永远是一行**——前端按 `\n` 切行，永远切在事件边界。

### 2. 判别联合类型（Discriminated Union）

`AgentEvent` 用 `type` 字段做判别键，`switch(event.type)` 时 TS 自动收窄类型：

```ts
type AgentEvent = TextEvent | ToolCallEvent | SourcesEvent | ErrorEvent | DoneEvent;
```

- **为什么不用字段名猜类型**：字段会撞车（`ErrorEvent` 和新事件都有 `message`），`type` 是唯一不重叠的标签。
- **面试名词**：接口隔离原则（ISP）+ 判别联合 + 穷尽性检查（exhaustiveness check）。
- **同款套路**：Anthropic content block（`type:"text"|"tool_use"`）、Redux action、百度/DeepSeek SSE 的 `event:` 字段。

### 3. 半行缓冲（手写解析时的关键）

`reader.read()` 返回的是网络层 chunk，边界任意，**和 `\n` 行边界无关**。需要：
- **字节层**：`decoder.decode(value, { stream: true })` 缓存被切断的多字节字符（中文）
- **行层**：`buffer` 暂存未完成的尾行，只处理完整的整行

漏写 `buffer = buffer.slice(nl + 1)` → 死循环（指针卡在同一行，buffer 永不缩短）。

> **用 `fetchEventSource` 库后，这两层缓冲库都帮你做了，手写 while 循环可以删掉。**

### 4. SSE vs NDJSON 选型权衡

| | SSE（最终选择） | NDJSON（过渡方案） |
|---|---|---|
| 格式 | `event:<type>\ndata:{json}\n\n` | `{json}\n` |
| 事件边界 | 空行（`\n\n`） | 单个 `\n` |
| 类型放哪 | `event:` 行 + JSON 里 `type` | JSON 里 `type` |
| 浏览器原生 `EventSource` | ✅（但只支持 GET） | ❌ |
| POST 接口 | ✅ fetch + 库解析 | ✅ fetch + 手写解析 |
| 调试体验 | Chrome DevTools EventStream 标签（仅 EventSource 触发） | Preview 标签看原始 |
| 行业对齐 | ✅ DeepSeek/百度网盘 AI 都用 | 较少 |

**关键澄清**（容易混淆的点）：
- **SSE 是响应格式**，POST 完全可以返回 SSE —— DeepSeek、百度网盘都是 POST + SSE。
- **`EventSource` 是浏览器客户端 API**，只支持 GET，用不了 POST body。
- POST 接口用 SSE → 必须 `fetch` 手写或用 `fetchEventSource` 库解析，无法使用 `EventSource` 的自动重连。
- **`fetchEventSource`（`@microsoft/fetch-event-source`）** 就是为这个痛点造的：POST + SSE + 自动重连。

**为什么最终选 SSE 而不留 NDJSON**：
- 行业对齐（大厂 AI Agent 主流做法）
- 库（`fetchEventSource`）帮你兜了 SSE 规范的所有边角（多行 data、行分隔符变体、重连）
- Chrome DevTools EventStream 视图对 `EventSource` 有原生支持；`fetch` 方式看 Preview 也能读

## 工程实现

### 关键文件

```
lib/agent/runtime/events.ts    ← 事件类型定义 + serializeEvent（SSE 格式）
lib/agent/runtime/index.ts     ← executeTools 返回结构化对象，enqueueEvent 发送
app/api/chat/route.ts          ← Content-Type: text/event-stream + done/error 事件
lib/chat/chat-session.ts            ← fetchEventSource 替代手写 reader 循环
```

### 后端序列化（events.ts）

```ts
export function serializeEvent(event: AgentEvent): string {
  return `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`;
}
// JSON.stringify 转义内部换行，保证 data: 行永远单行，不破坏 SSE 字段边界
```

### 前端消费（chat-session.ts）

```ts
await fetchEventSource("/api/chat", {
  method: "POST",
  body: JSON.stringify({ messages, sessionId }),
  onopen: async (res) => { if (!res.ok) throw new Error(...); },
  onmessage: (ev) => {
    const evt: AgentEvent = JSON.parse(ev.data);  // 库已解析好单条事件
    handleEvent(evt);   // switch(evt.type) 分发，逻辑完全不变
    onUpdate();
  },
  onerror: (err) => { throw err; },  // 抛出让外层 catch 处理，禁止库自动重试
});
```

**`handleEvent` 一行没改**——协议的传输层（怎么序列化/解析）和业务层（收到事件怎么处理）完全解耦，换协议只动传输层。

### 对比真实产品的 SSE 事件流

DeepSeek（`event:` 全用默认 `message`，类型信息在 JSON 里）：
```
data:{"v":"要保持"}\n\n
data:{"v":"简洁"}\n\n
```

我们的项目（显式 `event:` 行，调试更可读）：
```
event:tool_call
data:{"type":"tool_call","toolCall":{"name":"get_current_time",...}}\n\n

event:text
data:{"type":"text","content":"---\n\n### 今天是 2026年6月6日"}\n\n

event:done
data:{"type":"done"}\n\n
```

## 踩坑记录

- **`buffer += evt.content` 混淆缓冲区与正文**：`buffer` 是缓存"半行网络数据"的，正文要拼到 `last().content`。两者混用会导致正文丢失 + buffer 污染。
- **error case 用赋值而非 throw**：`case "error": last().error = ...` 不会中断流，且 Message 类型无 `error` 字段。必须 `throw new Error(...)` 才能让外层 catch 接管。
- **`EventSource` 只支持 GET 的误解**：POST 完全可以返回 SSE，只是无法使用浏览器原生 `EventSource` 客户端。不要把"SSE 格式"和"EventSource API"混为一谈。
- **Chrome DevTools EventStream 标签不出现**：`fetchEventSource` 用 `fetch` 实现，DevTools 的 EventStream 专属视图只对 `EventSource`（XHR）触发。用 Preview 标签能看到原始 SSE 文本，一样可以调试。
- **`onerror` 必须 throw**：`fetchEventSource` 的 `onerror` 如果不抛异常，库会自动重试——聊天接口不需要重试，必须 throw 让外层处理。

## 延伸阅读

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [@microsoft/fetch-event-source](https://github.com/Azure/fetch-event-source)
- 同款判别联合：[Anthropic content block types](https://docs.anthropic.com/en/api/messages)
- Planning 已落地；新增事件仍需同步扩展事件联合类型、SSE 序列化和前端 `switch` 分支。
