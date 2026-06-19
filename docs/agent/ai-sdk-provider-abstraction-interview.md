# AI SDK Provider 抽象替换面试说明

## 一句话概括

这次改造不是把整个 Agent Runtime 换成 AI SDK，而是把底层模型调用抽成 Provider 层：上层仍保留自研 Agent Loop、工具执行、Trace、上下文压缩和 Usage 统计，底层通过 Vercel AI SDK 统一对接 OpenAI-compatible 模型服务。

这个方案的核心价值是：降低模型供应商耦合，同时不牺牲已有 Agent 系统里的可观测性、工具编排和上下文治理能力。

## 背景问题

原来的 runtime 直接使用 Anthropic SDK 调 DeepSeek 的 Anthropic-compatible 接口。这样短期能跑，但会带来几个问题：

- 模型调用逻辑和业务 runtime 耦合在一起，后续切模型、切供应商成本高。
- 工具调用格式和模型协议绑定太深，迁移时容易影响 agent loop。
- 流式输出、工具调用、usage 统计分别散落在 runtime 中，不利于统一治理。
- DeepSeek 既支持 Anthropic-compatible，也支持 OpenAI-compatible，不同 endpoint 的协议差异需要集中处理。

所以这次的目标是引入 Provider Adapter，把模型调用相关的协议转换收敛到一个文件里。

## 设计目标

这次改造的设计目标有四个：

1. 保留自研 Agent Loop。

   `runAgentLoop` 仍然负责多轮推理、工具调用、重复工具调用保护、上下文预算、trace 写入和最终收敛。

2. 只替换模型调用层。

   用 AI SDK 接管 `generateText`、`streamText` 和 OpenAI-compatible provider 创建，但不使用 AI SDK 的完整 Agent Loop。

3. 保持旧 runtime 的返回结构。

   上层代码原本消费的是 Anthropic 风格的 `content`、`tool_use`、`stop_reason`、`usage`，Provider 层需要把 AI SDK 的结果再适配回这个结构。

4. 保持现有观测和计费逻辑稳定。

   Usage、cache hit、cache write、工具结果压缩、trace 详情页都不能因为 provider 替换而丢失。

## 改造后的结构

新增文件：

- `lib/agent/runtime/model-provider.ts`

主要职责：

- 创建 AI SDK provider。
- 解析 DeepSeek OpenAI-compatible base URL。
- 将 Anthropic-style messages 转换成 AI SDK model messages。
- 将 Anthropic-style tools 转换成 AI SDK tools。
- 将 AI SDK 的 stream result 转回 runtime 使用的 Anthropic-like result。
- 统一映射 usage、cache token、finish reason。

Runtime 接入点：

- `callModel(...)`
- `callCompressionModel(...)`
- `streamModelResponse(...)`
- `forwardTextStream(...)`

这些函数的外部签名基本保持不变，上层 agent loop 不需要感知底层 provider 已经替换。

## 调用链路

### 普通 Agent 调用

链路如下：

```txt
runAgentLoop
  -> callModel
    -> callModelWithProvider
      -> AI SDK streamText
      -> consume fullStream
      -> convert result to Anthropic-like Message
  -> extract text / tool_use
  -> executeTools
  -> appendToolResults
  -> next loop
```

关键点是 `callModelWithProvider` 内部使用 `streamText`，但不会让 AI SDK 自动执行工具。AI SDK 只负责让模型生成工具调用，真正的工具执行仍由现有 `executeTools` 完成。

### 上下文压缩调用

链路如下：

```txt
compactLoopMessagesSemantic
  -> callCompressionModel
    -> generateTextWithProvider
      -> AI SDK generateText
```

上下文压缩本身仍由 runtime 控制，包括触发时机、窗口大小、保留 primer/recent messages、fallback 策略和 trace 记录。

### 第二阶段纯文本总结

当工具轮数达到上限或出现重复工具调用时，会进入第二阶段总结：

```txt
streamModelResponse
  -> streamTextWithProvider
  -> forwardTextStream
  -> SSE text event
```

这里不带 tools，只做纯文本流式输出。

## Provider 创建

DeepSeek 当前配置可能是 Anthropic-compatible endpoint：

```txt
https://api.deepseek.com/anthropic
```

但 AI SDK 的 OpenAI provider 需要 OpenAI-compatible endpoint，所以 Provider 层做了兼容：

```ts
function resolveOpenAIBaseURL() {
  if (process.env.AI_SDK_BASE_URL) return process.env.AI_SDK_BASE_URL;
  if (process.env.DEEPSEEK_OPENAI_BASE_URL) return process.env.DEEPSEEK_OPENAI_BASE_URL;
  if (deepseekConfig.baseURL.endsWith("/anthropic")) {
    return deepseekConfig.baseURL.replace(/\/anthropic$/, "/v1");
  }
  return deepseekConfig.baseURL;
}
```

优先级是：

1. `AI_SDK_BASE_URL`
2. `DEEPSEEK_OPENAI_BASE_URL`
3. 自动把 `/anthropic` 转成 `/v1`
4. 兜底使用原始 `deepseekConfig.baseURL`

这样做的好处是迁移成本低，不要求立即修改所有环境变量。

## Message 格式转换

原 runtime 使用 Anthropic 风格消息：

```ts
type ModelMessage = Anthropic.MessageParam;
```

其中 assistant 工具调用长这样：

```ts
{
  type: "tool_use",
  id: "...",
  name: "web_search",
  input: {...}
}
```

AI SDK 需要转换成：

```ts
{
  type: "tool-call",
  toolCallId: "...",
  toolName: "web_search",
  input: {...}
}
```

工具结果原来是 user message 里的 `tool_result`：

```ts
{
  type: "tool_result",
  tool_use_id: "...",
  content: "..."
}
```

AI SDK v6 需要的是 role 为 `tool` 的 message，并且 content 是 `tool-result`：

```ts
{
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "...",
      toolName: "web_search",
      input: {},
      output: {
        type: "text",
        value: "..."
      }
    }
  ]
}
```

这里有一个关键坑：`output` 不能直接放字符串，否则 AI SDK 的 prompt schema 校验会报 `invalid_union`。

## Tool Name 映射

Anthropic 的 `tool_result` 里只有 `tool_use_id`，没有工具名。

但 AI SDK 的 `tool-result` 需要 `toolName`。所以 Provider 层维护了一个 Map：

```ts
const toolNameByCallId = new Map<string, string>();
```

当遇到 assistant 的 `tool_use` 时记录：

```ts
toolNameByCallId.set(block.id, block.name);
```

当遇到 user/tool 的 `tool_result` 时反查：

```ts
toolName: toolNameByCallId.get(block.tool_use_id) ?? "unknown"
```

这保证了历史消息中工具调用和工具结果能正确配对。

## Tool Schema 转换

原工具定义是 Anthropic 风格：

```ts
{
  name,
  description,
  input_schema
}
```

AI SDK 需要：

```ts
{
  description,
  inputSchema
}
```

所以转换逻辑是：

```ts
function toAITools(tools: Anthropic.Tool[]) {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.input_schema as any),
      },
    ]),
  );
}
```

这里用 `jsonSchema(...)` 是为了复用现有工具的 JSON Schema，不需要重新用 Zod 定义一套工具参数。

## Stream 处理策略

最开始容易写成这样：

```ts
for await (const delta of result.textStream) {
  onTextDelta(delta);
}

const text = await result.text;
const toolCalls = await result.toolCalls;
```

但这个方式有风险：

- `textStream` 已经消费了流，后面再读 `text` / `toolCalls` 可能触发二次消费问题。
- 工具调用轮可能没有正文 text，AI SDK 可能抛出 `No output generated. Check the stream for errors.`
- 错误 chunk 不容易被统一处理。

最终改成只消费一次 `fullStream`：

```ts
let text = "";
let finishReason: string | undefined;
let usage: LanguageModelUsage | undefined;
const toolCalls: any[] = [];

for await (const part of result.fullStream) {
  if (part.type === "text-delta") {
    text += part.text;
    input.onTextDelta?.(part.text);
  } else if (part.type === "tool-call") {
    toolCalls.push(part);
  } else if (part.type === "finish") {
    finishReason = part.finishReason;
    usage = part.totalUsage;
  } else if (part.type === "error") {
    throw part.error;
  }
}
```

这个设计更稳定，因为文本、工具调用、usage、finish reason 都从同一条流里收集，不会重复消费。

## Stop Reason 映射

AI SDK 的 finish reason 和 Anthropic 的 stop reason 不完全一致。

当前映射：

```ts
function toStopReason(finishReason?: string): Anthropic.Messages.StopReason {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool-calls") return "tool_use";
  return "end_turn";
}
```

这样上层仍然可以用原来的判断：

```ts
if (initialResponse.stop_reason === "max_tokens") ...
if (toolUses.length === 0) ...
```

## Usage 和 Cache Token 映射

AI SDK 返回的 usage 是：

```ts
usage.inputTokens
usage.outputTokens
usage.inputTokenDetails.cacheReadTokens
usage.inputTokenDetails.cacheWriteTokens
```

runtime 原来使用 Anthropic-like 字段：

```ts
input_tokens
output_tokens
cache_read_input_tokens
cache_creation_input_tokens
```

所以 Provider 层做映射：

```ts
function toAnthropicUsage(usage?: LanguageModelUsage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
  };
}
```

这样 usage 页面、cache hit 统计、费用估算都能继续沿用现有逻辑。

## 为什么不直接用 AI SDK Agent

这是面试里很值得讲清楚的一点。

AI SDK Agent 能快速搭建工具调用流程，但当前项目已经有一套更细的 runtime 能力：

- 自定义工具执行器。
- 工具串行/并行策略。
- 工具结果压缩。
- 上下文压缩。
- Trace 可视化。
- Usage 计费和 cache 命中统计。
- SSE 结构化事件协议。
- 会话记忆和检索上下文注入。

如果直接替换成 AI SDK Agent，会把这些能力重新迁移一遍，风险很高。

所以更合理的策略是渐进式迁移：先把模型调用层 provider 化，等协议稳定后，再评估是否局部使用 AI SDK 的 agent 能力。

## 这次踩过的坑

### 1. Tool result output 不能直接放字符串

报错类似：

```txt
invalid_union
path: ["content", 0]
expected: object
```

根因是 AI SDK v6 的 `tool-result.output` 需要结构化对象。

修复方式：

```ts
output: {
  type: "text",
  value: stringifyToolResultContent(block.content),
}
```

### 2. Anthropic tool_result 缺少 toolName

Anthropic 的工具结果只带 `tool_use_id`，AI SDK 需要 `toolName`。所以需要通过前面的 `tool_use` 建立 `toolCallId -> toolName` 映射。

### 3. 不能同时消费 textStream 和 result.text

流式结果应该单路消费。否则工具调用轮可能出现：

```txt
No output generated. Check the stream for errors.
```

最终选择消费 `fullStream`，自己收集所有需要的信息。

### 4. DeepSeek endpoint 协议要匹配

AI SDK 的 OpenAI provider 要使用 OpenAI-compatible endpoint。如果环境变量仍指向 `/anthropic`，需要转换成 `/v1` 或显式配置 `DEEPSEEK_OPENAI_BASE_URL`。

## 面试回答模板

如果面试官问：“你们是怎么做模型 provider 抽象的？”

可以这样回答：

> 我们没有直接把 Agent Runtime 替换成某个框架，而是先把模型调用层抽出来。原来的 runtime 已经有工具执行、trace、上下文压缩、usage 统计等能力，所以我设计了一个 Provider Adapter，用 AI SDK 负责底层模型调用和 OpenAI-compatible 协议适配，上层仍然消费原来的 Anthropic-like message 结构。
>
> 这个 adapter 主要做三件事：第一，把 Anthropic 风格的 messages 和 tools 转换成 AI SDK 的 model messages 和 tools；第二，消费 AI SDK 的 fullStream，把 text delta、tool call、usage、finish reason 收集起来；第三，再把结果映射回 runtime 原来的 content、tool_use、stop_reason 和 usage 字段。
>
> 迁移中比较关键的坑是工具结果格式。Anthropic 的 tool_result 只有 tool_use_id 和字符串 content，但 AI SDK v6 需要 role 为 tool 的 message，并且 tool-result 里要有 toolName 和结构化 output，所以我加了 toolCallId 到 toolName 的映射，并把字符串结果包装成 `{ type: "text", value }`。另外为了避免流被二次消费，我没有同时读 textStream 和 result.text，而是统一消费 fullStream。

如果面试官追问：“为什么不直接用 AI SDK Agent？”

可以回答：

> 因为我们的 Agent Runtime 里已经沉淀了很多框架外能力，比如工具结果压缩、上下文压缩、trace 可视化、费用统计、cache 命中统计和 SSE 结构化事件。如果直接换成 AI SDK Agent，会带来较大迁移风险。所以我选择渐进式架构：先替换 provider 层，让模型供应商解耦；保留 runtime 的编排能力。这样既能获得 AI SDK 的模型适配生态，也不会丢掉已有系统的可观测性和工程控制力。

如果面试官追问：“怎么保证迁移稳定？”

可以回答：

> 我保持了 `callModel`、`callCompressionModel`、`streamModelResponse` 这些 runtime 函数的外部语义不变，上层 agent loop 不需要大改。迁移后跑了 TypeScript 类型检查和 eval 测试，同时重点验证了工具调用轮、纯文本轮、usage 映射、cache token 映射和上下文压缩调用。这样迁移面比较小，回归风险可控。

## 当前方案的优点

- Provider 和 runtime 解耦，后续可以更容易切换模型服务。
- 保留现有 Agent Loop，不丢 trace、压缩、usage 等能力。
- 工具协议转换集中在一个文件里，后续排查更容易。
- 支持 DeepSeek OpenAI-compatible endpoint，同时兼容旧环境变量。
- 流式处理统一走 `fullStream`，避免二次消费和工具调用空文本问题。

## 后续可以继续优化

- 把 `any` 类型逐步收紧成 AI SDK 的 `ModelMessage` / `ToolSet` 类型。
- 给 `toAIMessage`、`toAITools`、`toAnthropicUsage` 加单元测试。
- 在 trace 中记录 provider 名称、baseURL 类型、finishReason 原始值。
- 增加 provider registry，支持 DeepSeek、OpenAI、OpenRouter、Azure OpenAI 等多供应商。
- 为不同 provider 配置独立的模型能力表，例如是否支持 tool call、cache usage、reasoning tokens。
- 在 usage 页面区分模型原始 usage 和 runtime 估算 usage，方便对账。

## 结论

这次改造本质上是一次边界重构：把模型协议适配从 Agent Runtime 中剥离出来，让 runtime 专注于 agent 编排，让 provider 专注于模型调用。

这种做法比直接替换整个 agent 框架更稳，也更适合已经有复杂工程能力的项目。面试里可以重点强调“渐进式迁移”“协议适配层”“工具调用格式转换”“流式消费策略”和“保留可观测性”这几个关键词。
