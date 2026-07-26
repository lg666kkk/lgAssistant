# 模型流式输出的解析链路与观测

> 上游是模型的 SSE 字节流，下游是 [结构化事件协议](./structured-event-protocol.md) 发给前端的 `tool_call` / `text` 事件。
> 这份笔记讲中间那段：**Vercel AI SDK 怎么把逐帧碎片拼成完整的工具调用**，以及怎么把两层输出打出来看。

## 这个功能解决什么问题

工具调用的参数不是一次返回的。模型按 token 生成，OpenAI 兼容协议把它切成一串 SSE 帧，`arguments` 是**逐段拼接的 JSON 文本**：

```
帧1  {"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"web_search","arguments":""}}]}
帧2  {"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}
帧3  {"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"Vercel A"}}]}
...
```

注意帧 2 之后 **`id` 和 `name` 都没了**，只能靠 `index` 归组；单帧的 `arguments` 是**残缺 JSON**，parse 会抛。谁来攒、什么时候算攒完、攒完怎么校验，就是这条链路要解决的问题。

结论：**这层由 AI SDK 完成，本项目不写任何 partial JSON 逻辑**，[model-provider.ts](../../../lib/agent/runtime/model-provider.ts) 拿到的 `tool-call` part 已经是 `input` 为对象的完整调用。

## 核心概念

### 1. 四层管道

```
HTTP response.body (Uint8Array)
  ↓ ① TextDecoderStream → EventSourceParserStream → safeParseJSON(zod)   provider-utils
ParseResult<OpenAIChatChunk>          单条 SSE data 行 → 校验过的对象
  ↓ ② TransformStream 状态机 doStream                                     @ai-sdk/openai
LanguageModelV3StreamPart             tool-input-start/delta/end + tool-call（input 仍是 string）
  ↓ ③ runToolsTransformation → parseToolCall                              ai core
TypedToolCall                         input 变成过了 schema 校验的 object
  ↓ ④ streamText → result.fullStream
callModelWithProvider 的 for await
```

每层职责单一：① 只管分帧和单帧合法性，② 只管跨帧拼接，③ 只管语义校验。**跨 chunk 的字节切断**（一个 JSON 被 TCP 切两半、中文被切一半）由 `TextDecoderStream` + `EventSourceParserStream` 兜住，这是整条链路唯一的"手写 buffer"，且不在 AI SDK 里（第三方库 `eventsource-parser`）。

### 2. 第②层：靠 index 归组的拼接状态机

状态存在 `TransformStream` 闭包外（`@ai-sdk/openai/src/chat/openai-chat-language-model.ts` 的 `doStream`）：

```ts
const toolCalls: Array<{
  id: string;
  function: { name: string; arguments: string };  // 累加中的 JSON 文本
  hasFinished: boolean;                            // 幂等哨兵
}> = [];
```

- **首帧**（`toolCalls[index] == null`）：`id` / `function.name` 缺任一个直接抛 `InvalidResponseDataError`，然后建槽位并发 `tool-input-start`。
- **后续帧**：`arguments +=` 字符串拼接，同时把增量原样透出成 `tool-input-delta`。
- **完成判定**：不等 `finish_reason`，而是**每拼一次就试 parse 一次**，一旦成立就发 `tool-input-end` + `tool-call`，并置 `hasFinished = true`（之后该 index 的帧全部 `continue`）。

### 3. 为什么用"试 parse"而不是等 finish_reason

| | 试 parse（AI SDK 的选择） | 等 finish_reason |
|---|---|---|
| 首个工具可用时机 | 参数一完整就发出 | 整条流结束才发 |
| 多工具并行 | 第一个可以先执行 | 全部等最慢的 |
| 兼容"整个调用一帧返回" | ✅ 首帧就判定完成 | ✅ |
| 理论风险 | 前缀本身合法的 JSON 会被提前判完成 | 无 |

那个"理论风险"实际不成立：工具参数的根类型恒为 object，`{...` 的任何真前缀都不是合法 JSON。所以这是**零代价换低延迟**。

`isParsableJson` 底层是 `secureJsonParse`（fastify 那套防原型污染实现），命中 `__proto__` / `constructor` 键直接抛 `SyntaxError`——模型输出是不可信输入，这道防线必要。

### 4. 第③层：parse 和 schema 校验合并成一步

`doParseToolCall` 用的是你传进去的 `jsonSchema(tool.input_schema)`：

```ts
const parseResult = toolCall.input.trim() === ""
  ? await safeValidateTypes({ value: {}, schema })       // 空参数当 {}
  : await safeParseJSON({ text: toolCall.input, schema }); // parse + 校验一步到位
```

三级降级：

1. `NoSuchToolError` / `InvalidToolInputError` → 若配了 `repairToolCall` 就回调修复（可以再叫一次模型改参数）后重试
2. 修复失败 → 降级成 `{ invalid: true, dynamic: true, error, input: 能 parse 就 object 否则原 string }`
3. 下游见 `invalid` 直接产出 `tool-error`，**不执行工具**

本项目没传 `repairToolCall`，所以是 1 跳过、直接 2→3。这是一个明确的待选项：真实场景里模型漏必填字段并不罕见，接上 repair 能省一轮完整的 agent loop。

## 关键代码走读

### 消费侧只认三种 part

[model-provider.ts](../../../lib/agent/runtime/model-provider.ts) 的 `callModelWithProvider`：

```ts
for await (const part of result.fullStream) {
  debug.log(part);
  if (part.type === "text-delta") { text += part.text; input.onTextDelta?.(part.text); }
  else if (part.type === "tool-call") { toolCalls.push(part); }   // input 已是 object
  else if (part.type === "finish") { finishReason = ...; usage = ...; }
  else if (part.type === "error") { debug.flush(); throw part.error; }
}
```

然后重新包成 Anthropic 风格的 `tool_use` content block，让上层 agent loop 只面对一种消息格式（Anthropic 是本项目的内部规范格式，provider 可换）。

**`tool-input-start` / `tool-input-delta` 目前被丢弃**。它们正是"工具名已知、参数正在生成"的信号。当前 UI 是工具执行完才一次性出卡片（`tool_call` 事件在 [runtime/index.ts](../../../lib/agent/runtime/index.ts) 里于 `executeTools` 之后才 enqueue，payload 含结果），如果要做"正在调用 web_search…"的中间态，只需在这个 switch 补两个 case 转成新 SSE 事件，不用动 provider 层。参数半成品若要渲染，AI SDK 导出了 `parsePartialJson`。

### 两层输出的观测开关

`DEBUG_AI_STREAM` 环境变量，`createStreamDebugger` 实现：

| 值 | 打印内容 |
|---|---|
| 不设 / `off` / `0` | 关闭（`includeRawChunks` 也不开，无额外开销） |
| `raw` | 第①层：模型原始 SSE 帧 |
| `parts` / `1` | 第③④层：AI SDK 处理后的 part |
| `all` | 两层交替，可直接对照 |

```bash
DEBUG_AI_STREAM=all npm run dev
```

两个设计点：

- **`includeRawChunks` 按需开**。这是 provider 内置的开关（`if (options.includeRawChunks) controller.enqueue({ type: 'raw', rawValue })`），关闭时连 raw part 都不入队，所以生产环境零成本。
- **`text-delta` 只累计不逐条打**。每 token 一条会把工具调用的日志淹掉，改成结束时汇总 `textDeltas` / `textChars`。

最终回答阶段（`streamTextWithProvider`）返回的是 `textStream`，拿不到完整 part 流，所以借 `onChunk` / `onFinish` 观测，不改调用方拿到的返回结构。

### 实测输出

用伪造的 SSE 帧跑真实 SDK 管道（参数被切成 4 段），`all` 模式下的输出：

```
02 RAW    {"role":"assistant","content":""}
04 RAW    {"content":"我来查一下。"}
05 PART   text-delta       {"id":"0","text":"我来查一下。"}
06 RAW    {"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"web_search","arguments":""}}]}
07 PART   tool-input-start {"id":"call_abc123","toolName":"web_search","dynamic":false}
08 RAW    {"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}
09 PART   tool-input-delta {"id":"call_abc123","delta":"{\"qu"}
10 RAW    {"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"Vercel A"}}]}
...
16 PART   tool-input-end   {"id":"call_abc123"}
17 PART   tool-call        {"toolCallId":"call_abc123","toolName":"web_search","input":{"query":"Vercel AI SDK 流式","topK":3}}
22 PART   finish           {"finishReason":"tool-calls","rawFinishReason":"tool_calls",...}
```

三处值得注意：

1. **RAW 和 PART 严格交替**——`TransformStream` 是同步逐帧转换，没有内部缓冲队列。
2. **第 17 行是唯一一处 string → object 的跃变**：前面所有 `tool-input-delta` 的 `delta` 都是文本碎片，`tool-call` 的 `input` 已是 `{query, topK}` 对象，且 `topK` 是 number（schema 校验的产物，不是 JSON.parse 的）。
3. **`finishReason` 有两份**：`rawFinishReason: "tool_calls"` 是 OpenAI 原值，`finishReason: "tool-calls"` 是 SDK 归一化后的值。本项目的 `toStopReason` 消费的是后者，再翻译成 Anthropic 的 `tool_use`——三套命名，改这块时容易错。

## 踩坑记录

- **改 `node_modules/@ai-sdk/openai/src/*.ts` 完全无效**。那个 `src` 只是随包发布的源码参考，`exports` 指向 `dist/index.mjs`（Next 服务端走 ESM）。真要插日志得改 dist，且要重启 dev server（webpack 不 watch node_modules）、`npm i` 会冲掉（需 `patch-package`）、`output: "standalone"` 会把改动 trace 进产物。**优先用 `includeRawChunks` / middleware / 自己的 for await，别碰 node_modules。**
- 想观测第②层（provider 输出、`tool-call.input` 还是 string 那个形态）用 `wrapLanguageModel` + middleware 的 `wrapStream`，`specificationVersion: "v3"`。
- `onChunk` 覆盖不到 `tool-input-end` 和 `finish`，只有 `text-delta` / `reasoning-delta` / `source` / `tool-call` / `tool-input-start` / `tool-input-delta` / `tool-result` / `raw`。要全量 part 必须自己遍历 `fullStream`。
- AI SDK v5→v6 换过 part 命名，v4 时代叫 `tool-call-delta`，`LanguageModelV2` → `V3`。翻旧文档/旧博客会对不上，以 `node_modules/@ai-sdk/provider/dist/index.d.ts` 为准。
- 本项目走的是 **OpenAI Chat Completions 协议**（`createOpenAI` + DeepSeek 兼容端点），不是 Anthropic 的 `input_json_delta`。虽然内部消息格式是 Anthropic 风格，但线上协议无关，别照着 Anthropic 流式文档找 `content_block_delta`。
