# Agent 工具调用 UI、Calculator 与多工具调用实战总结

## 1. 本阶段目标

本阶段是在已经完成 `get_current_time` 工具闭环的基础上，继续推进 Agent 工具系统，重点完成三件事：

1. 在前端聊天 UI 中展示工具调用信息。
2. 新增第二个工具 `calculator`。
3. 支持模型在一次回复中调用多个工具。

最终实现的效果是：

```text
用户提问
  ↓
模型判断是否需要调用工具
  ↓
后端执行一个或多个工具
  ↓
工具结果回传给模型
  ↓
模型生成最终自然语言回答
  ↓
前端展示正文 + 工具调用卡片
  ↓
工具调用信息落库，刷新后仍可恢复
```

---

## 2. 涉及文件

本阶段主要修改了以下文件：

```text
app/api/chat/route.ts
lib/chat/chat-session.ts
app/page.tsx
lib/agent/tools/calculator.ts
lib/agent/tools/builtin.ts
```

其中：

- `app/api/chat/route.ts`：后端工具调用、多工具执行、工具 marker 注入。
- `lib/chat/chat-session.ts`：前端流式响应解析、工具调用数据落库。
- `app/page.tsx`：工具调用 UI 展示。
- `lib/agent/tools/calculator.ts`：新增 calculator 工具。
- `lib/agent/tools/builtin.ts`：注册内置工具。

---

## 3. 工具调用 UI 可视化

### 3.1 扩展 Message 类型

在 `lib/chat/chat-session.ts` 中，为消息类型增加 `toolCalls` 字段：

```ts
toolCalls?: Array<{
  name: string;
  input?: unknown;
  ok: boolean;
  content: string;
  error?: string;
}>;
```

这个字段用于保存一次 assistant 回复中发生的工具调用记录。

之所以使用数组，是因为未来一次回复可能调用多个工具。

---

### 3.2 后端注入工具调用 marker

后端在执行工具后，把工具调用信息以特殊 marker 的形式写入流式响应：

```text
__TOOL_CALL__
{...tool call json...}
__END_TOOL_CALL__
```

示例：

```json
{
  "name": "calculator",
  "input": {
    "expression": "128 * 37 + 99"
  },
  "ok": true,
  "content": "128 * 37 + 99 = 4835"
}
```

加入结束标记 `__END_TOOL_CALL__` 的原因是：前端需要准确知道工具调用 JSON 的结束位置。

如果只有开始标记，流式正文可能紧跟在 JSON 后面，前端无法稳定判断 JSON 到哪里结束。

---

### 3.3 前端解析工具 marker

前端在 `lib/chat/chat-session.ts` 中解析流式响应。

核心思路：

```text
fullText：原始响应文本，包含协议标记

displayText：用于展示给用户的文本，需要移除协议标记
```

解析流程：

1. 从 `displayText` 中查找 `__TOOL_CALL__`。
2. 查找对应的 `__END_TOOL_CALL__`。
3. 截取中间 JSON。
4. `JSON.parse` 得到工具调用对象。
5. 写入当前 assistant 消息的 `toolCalls`。
6. 从 `displayText` 中移除 marker 和 JSON。

---

### 3.4 解决 marker 匹配失败问题

一开始前端使用严格 marker：

```ts
const toolMarker = "\n\n__TOOL_CALL__\n";
const endToolMarker = "\n__END_TOOL_CALL__\n";
```

实际流式文本中，换行数量可能和预期不完全一致，导致解析失败，页面直接显示：

```text
TOOL_CALL {...} END_TOOL_CALL
```

后来改成宽松匹配：

```ts
const toolMarker = "__TOOL_CALL__";
const endToolMarker = "__END_TOOL_CALL__";
```

并在移除 marker 后执行：

```ts
displayText = displayText.trimStart();
```

这样解析更加稳定。

---

## 4. 工具调用 UI 展示

在 `app/page.tsx` 中，基于 `msg.toolCalls` 渲染工具调用卡片。

展示内容包括：

- 工具名称
- 工具输入参数
- 工具执行状态

示例 UI 内容：

```text
工具调用
工具：calculator
输入：{"expression":"128 * 37 + 99"}
状态：成功
```

这一步让工具调用变得可观察，方便调试 Agent 行为。

---

## 5. 工具调用信息落库

### 5.1 保存时写入 metadata

工具调用信息最初只存在前端内存中，刷新页面后会丢失。

解决方式是在保存 assistant 消息时，将 `toolCalls` 写入 `metadata`：

```ts
metadata: {
  ...metadata,
  toolCalls: lastMessage.toolCalls,
}
```

---

### 5.2 加载历史时恢复

加载历史消息时，从数据库消息的 metadata 中恢复：

```ts
toolCalls: msg.metadata?.toolCalls,
```

这样刷新页面后，工具调用卡片仍然可以显示。

---

## 6. 新增 calculator 工具

### 6.1 工具文件

新增文件：

```text
lib/agent/tools/calculator.ts
```

工具名称：

```text
calculator
```

用途：计算基础数学表达式。

---

### 6.2 输入类型

```ts
type CalculatorInput = {
  expression?: string;
};
```

通过 `parseInput(input: unknown)` 将模型传入的未知参数安全转换为内部类型。

---

### 6.3 输入 schema

工具通过 `input_schema` 告诉模型如何调用：

```ts
input_schema: {
  type: "object",
  properties: {
    expression: {
      type: "string",
      description: '要计算的数学表达式，如 "2 + 3 * 4"',
    },
  },
  required: ["expression"],
  additionalProperties: false,
}
```

---

### 6.4 安全校验

没有直接使用裸 `eval`。

第一版 calculator 只允许基础四则运算字符：

```ts
function isSafeExpression(expression: string): boolean {
  return /^[0-9+\-*/().\s]+$/.test(expression);
}
```

允许：

```text
数字
空格
小数点
+ - * / ( )
```

拒绝：

```text
字母
函数调用
变量
任意 JavaScript 代码
```

例如：

```text
128 * 37 + 99   ✅
sqrt(16)        ❌
process.exit()  ❌
```

---

### 6.5 执行计算

通过白名单校验后，使用：

```ts
Function(`"use strict"; return (${expression});`)();
```

然后检查结果：

```ts
typeof result === "number" && Number.isFinite(result)
```

避免返回：

```text
NaN
Infinity
非数字结果
```

---

### 6.6 错误处理

calculator 工具处理了以下失败情况：

- 缺少表达式参数
- 表达式包含不安全字符
- 计算结果不是有效数字
- 表达式计算异常

并统一返回 `ToolResult`：

```ts
{
  ok: false,
  content: "计算失败",
  error: "..."
}
```

保证工具失败不会直接中断整个聊天流程。

---

### 6.7 注册工具

在 `lib/agent/tools/builtin.ts` 中注册：

```ts
import { calculatorTool } from "./calculator";

registry.register(calculatorTool);
```

注册后，模型可同时看到：

```text
get_current_time
calculator
```

---

## 7. 多工具调用支持

### 7.1 后端从单工具升级为多工具

原先只取第一个工具调用：

```ts
const toolUse = initialResponse.content.find(
  (block) => block.type === "tool_use",
);
```

后来改成收集所有工具调用：

```ts
const toolUses = initialResponse.content.filter(
  (block) => block.type === "tool_use",
);
const toolUse = toolUses[0];
```

再进一步，将执行逻辑改成循环：

```ts
for (const toolUse of toolUses) {
  const toolResult = await executeToolCall(toolRegistry, {
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  });

  toolResultBlocks.push({
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: toolResult.content,
    is_error: !toolResult.ok,
  });

  enqueueText(toolMarker);
}
```

---

### 7.2 toolResultBlocks

新增 `toolResultBlocks` 数组，用于把多个工具结果一次性回传给模型：

```ts
const toolResultBlocks: Array<{
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}> = [];
```

第二轮模型调用中使用：

```ts
{
  role: "user",
  content: toolResultBlocks,
}
```

这样模型可以同时看到多个工具执行结果，再生成最终回答。

---

### 7.3 前端支持多个工具 marker

前端原本只解析第一个工具 marker：

```ts
const toolMarkerIndex = displayText.indexOf(toolMarker);
const endToolMarkerIndex = displayText.indexOf(endToolMarker);
```

后来升级为循环解析：

```text
while 找得到 __TOOL_CALL__ 和 __END_TOOL_CALL__
  解析一个工具 JSON
  加入 msg.toolCalls
  从 displayText 中移除这一段
  继续找下一个
```

---

### 7.4 防止重复追加

因为流式响应中 `fullText` 是累积文本，同一个工具 marker 会在后续 chunk 中反复存在。

如果每次都追加，会导致 UI 出现重复工具卡片。

最初使用布尔值：

```ts
let toolCallParsed = false;
```

但布尔值只适合单工具，不适合多工具。

后来升级为：

```ts
const parsedToolCallJsonSet = new Set<string>();
```

逻辑：

```ts
if (!parsedToolCallJsonSet.has(toolJson)) {
  // 追加工具调用
  parsedToolCallJsonSet.add(toolJson);
}
```

这样可以做到：

- 同一个工具 marker 不重复追加
- 不同工具 marker 都可以追加

---

## 8. 实测结果

### 8.1 calculator 单工具测试

测试问题：

```text
帮我算一下 128 * 37 + 99
```

结果：

```text
128 × 37 + 99 = 4835
```

工具卡片显示：

```text
工具：calculator
输入：{"expression":"128 * 37 + 99"}
状态：成功
```

---

### 8.2 多工具测试

测试问题：

```text
请同时完成两件事：1. 计算 128 * 37 + 99；2. 告诉我现在北京时间。
```

结果同时触发两个工具：

```text
calculator
get_current_time
```

工具卡片显示：

```text
工具：calculator
输入：{"expression":"128 * 37 + 99"}
状态：成功

工具：get_current_time
输入：{"timezone":"Asia/Shanghai","locale":"zh-CN"}
状态：成功
```

最终回答同时包含：

```text
计算结果：4835
当前北京时间
```

---

## 9. 本阶段踩坑与修复

### 9.1 marker 匹配太严格

问题：

```text
TOOL_CALL JSON 被显示到正文里
```

原因：

```text
前端要求 marker 前后换行完全一致，但流式文本中换行不稳定
```

修复：

```ts
const toolMarker = "__TOOL_CALL__";
const endToolMarker = "__END_TOOL_CALL__";
```

---

### 9.2 toolCalls 没有落库

问题：

```text
刷新后工具调用卡片消失
```

原因：

```text
toolCalls 只存在前端内存，保存 assistant 消息时没有写入数据库
```

修复：

```ts
metadata: {
  ...metadata,
  toolCalls: lastMessage.toolCalls,
}
```

---

### 9.3 追加工具调用导致重复卡片

问题：

```text
流式过程中同一个工具调用可能被重复追加
```

原因：

```text
fullText 是累计文本，旧 marker 会反复出现在后续解析中
```

修复：

```ts
const parsedToolCallJsonSet = new Set<string>();
```

用 Set 记录已经解析过的工具 JSON。

---

### 9.4 布尔值不适合多工具

问题：

```ts
let toolCallParsed = false;
```

只能表示是否解析过工具，无法区分多个不同工具。

修复：

```ts
const parsedToolCallJsonSet = new Set<string>();
```

---

## 10. 当前能力总结

当前 Agent 工具系统已经具备：

- 工具类型定义
- 工具注册表
- 内置工具注册
- 工具执行路由
- safe / confirm / dangerous 风险等级基础设计
- `get_current_time` 工具
- `calculator` 工具
- 后端工具调用
- 多工具执行
- 工具结果回传模型
- 流式响应 marker 协议
- 前端工具调用解析
- 多工具 UI 展示
- 工具调用信息落库
- 刷新后恢复工具调用卡片

---

## 11. 后续可继续学习方向

### 11.1 search_notes 工具

把当前 RAG 从“后端自动注入”改造成“模型显式调用工具”。

目标：

```text
模型判断需要查知识库
  ↓
调用 search_notes
  ↓
工具返回相关文档
  ↓
模型基于文档回答
```

---

### 11.2 create_todo 工具

开始学习有副作用工具。

重点：

- 写数据库
- 用户确认机制
- `riskLevel: "confirm"`
- 防止模型未经确认执行写操作

---

### 11.3 工具调用确认 UI

针对 `confirm` 风险等级的工具，在前端展示确认按钮：

```text
AI 想执行 create_todo
是否允许？
[确认] [取消]
```

---

### 11.4 更强的 calculator

后续可以支持：

- `sqrt`
- `pow`
- `sin/cos`
- 百分比
- 更安全的表达式 parser

最好不要继续依赖 `Function`，可以换成专门的数学表达式解析库。

---

## 12. 本阶段最终结论

本阶段已经从单工具调用扩展到多工具调用，并完成了工具调用 UI 可视化和持久化。

目前系统已经具备一个基础 Agent 工具框架，可以继续扩展更多工具，并逐步向真正的个人助理能力演进。
