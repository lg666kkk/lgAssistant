# 工具调用实战：从 0 实现 get_current_time

本文总结本次学习过程：从类型定义开始，手写一个真实工具 `get_current_time`，并通过脚本验证 `Registry -> Router -> Tool -> Result` 的最小闭环。

## 1. 本次完成的目标

我们完成了一个最小工具调用系统：

```text
ToolCall
  -> executeToolCall()
  -> ToolRegistry.get(name)
  -> riskLevel 安全检查
  -> tool.execute(input)
  -> ToolExecutionResult
```

已完成内容：

- **工具类型定义**：`ToolRiskLevel`、`ToolResult`、`ToolDefinition`、`ToolCall`、`ToolExecutionResult`
- **工具注册表**：`ToolRegistry`
- **真实工具**：`get_current_time`
- **内置工具入口**：`createBuiltinToolRegistry()`
- **工具路由器**：`executeToolCall()`
- **手动测试脚本**：`scripts/test-tool-call.ts`

## 2. 核心文件

```text
lib/agent/tools/types.ts
lib/agent/tools/registry.ts
lib/agent/tools/current-time.ts
lib/agent/tools/builtin.ts
lib/agent/tools/tool-router.ts
scripts/test-tool-call.ts
```

> 说明：`tool-router.ts` 当前放在 `lib/agent/tools/` 下可以运行。后续更推荐移动到 `lib/agent/runtime/tool-router.ts`，因为 Router 属于运行时执行逻辑，不是工具定义本身。

## 3. 类型定义

### ToolRiskLevel

用于描述工具风险等级：

```ts
export type ToolRiskLevel = "safe" | "confirm" | "dangerous";
```

含义：

- **safe**：可以自动执行，例如获取当前时间
- **confirm**：需要用户确认，例如写文件
- **dangerous**：默认拒绝，例如删除文件、执行危险命令

### ToolResult

表示工具自己的执行结果：

```ts
export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

重点理解：

- **content**：给模型看的自然语言文本
- **data**：给程序用的结构化数据

例如：

```ts
{
  ok: true,
  content: "当前时间：2026年5月16日星期六 00:21:32",
  data: {
    iso: "2026-05-15T16:21:32.984Z",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    formatted: "2026年5月16日星期六 00:21:32",
    timestamp: 1778862092984
  }
}
```

### ToolDefinition

表示一个工具本身：

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  execute(params: unknown): Promise<ToolResult>;
}
```

它回答的是：

```text
这个工具叫什么？
什么时候用？
需要什么参数？
风险等级是什么？
怎么执行？
```

### ToolCall

表示一次工具调用请求：

```ts
export interface ToolCall {
  id?: string;
  name: string;
  input: unknown;
}
```

例如：

```ts
{
  name: "get_current_time",
  input: {
    timezone: "Asia/Shanghai",
    locale: "zh-CN"
  }
}
```

### ToolExecutionResult

表示 Router 执行后的增强结果：

```ts
export interface ToolExecutionResult extends ToolResult {
  toolName: string;
  toolCallId?: string;
}
```

它比 `ToolResult` 多了：

- **toolName**：实际执行的工具名
- **toolCallId**：对应哪一次工具调用

## 4. ToolRegistry

`ToolRegistry` 是工具注册表，负责管理所有工具。

核心职责：

```text
注册工具
按名称查找工具
列出所有工具
生成给模型看的工具列表
```

核心方法：

```ts
register(tool: ToolDefinition): void
get(name: string): ToolDefinition | undefined
list(): ToolDefinition[]
listForModel(): Array<Pick<ToolDefinition, "name" | "description" | "input_schema">>
```

关键点：

- 内部使用 `Map<string, ToolDefinition>` 保存工具
- `register` 会检查重复注册
- `listForModel` 不返回 `execute`，因为模型不应该看到后端函数

## 5. get_current_time 工具

文件：

```text
lib/agent/tools/current-time.ts
```

这个工具支持两个可选参数：

```ts
type CurrentTimeInput = {
  timezone?: string;
  locale?: string;
};
```

### parseInput

因为 `execute(input: unknown)` 的输入不可信，所以先用 `parseInput` 做参数清洗：

```text
unknown 输入
  -> 判断是不是对象
  -> 只提取 string 类型的 timezone / locale
  -> 返回 CurrentTimeInput
```

这一步体现了一个重要原则：

```text
不要信任模型传来的参数。
```

### input_schema

工具使用 JSON Schema 描述参数：

```ts
input_schema: {
  type: "object",
  properties: {
    timezone: { type: "string" },
    locale: { type: "string" }
  },
  required: [],
  additionalProperties: false
}
```

`additionalProperties: false` 表示：

```text
不允许模型传 schema 中没有声明的额外字段。
```

例如只允许：

```json
{
  "timezone": "Asia/Shanghai",
  "locale": "zh-CN"
}
```

不鼓励：

```json
{
  "timezone": "Asia/Shanghai",
  "format": "24h"
}
```

### execute

工具执行时：

1. 解析参数
2. 创建当前时间 `new Date()`
3. 用 `Intl.DateTimeFormat` 格式化
4. 成功返回 `ok: true`
5. 出错返回 `ok: false`

错误处理用于捕获非法时区，例如：

```text
Mars/Beijing
```

## 6. builtin.ts

文件：

```text
lib/agent/tools/builtin.ts
```

作用：创建内置工具注册表。

核心逻辑：

```ts
export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(getCurrentTimeTool);
  return registry;
}
```

以后新增内置工具时，也会在这里注册。

## 7. Tool Router

文件：

```text
lib/agent/tools/tool-router.ts
```

核心函数：

```ts
executeToolCall(registry, toolCall)
```

执行流程：

```text
1. 根据 toolCall.name 查找工具
2. 如果工具不存在，返回 ok: false
3. 如果工具 riskLevel 不是 safe，返回需要确认
4. 执行 tool.execute(toolCall.input)
5. 把 ToolResult 包装成 ToolExecutionResult
```

关键点：

```ts
const result = await tool.execute(toolCall.input);

return {
  ...result,
  toolName: tool.name,
  toolCallId: toolCall.id,
};
```

这里不能直接返回 `tool.execute(...)`，因为它返回的是 `ToolResult`，缺少 `toolName` 和 `toolCallId`。

## 8. 手动测试脚本

文件：

```text
scripts/test-tool-call.ts
```

测试脚本做了四件事：

```text
1. 创建内置工具注册表
2. 构造 ToolCall
3. 调用 executeToolCall
4. console.log 输出结果
```

正常测试输入：

```ts
const toolCall = {
  name: "get_current_time",
  input: {
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
  },
};
```

运行命令：

```bash
npx tsx scripts/test-tool-call.ts
```

正常输出包含：

```text
ok: true
toolName: "get_current_time"
content: "当前时间：..."
```

## 9. 已测试的三条路径

### 正常工具调用

输入：

```ts
name: "get_current_time"
timezone: "Asia/Shanghai"
locale: "zh-CN"
```

结果：

```text
ok: true
返回当前时间
```

### 工具不存在

输入：

```ts
name: "not_exists"
```

结果：

```ts
{
  ok: false,
  toolName: "not_exists",
  content: "工具不存在：not_exists",
  error: "Unknown tool: not_exists"
}
```

说明 Router 的未知工具分支正常。

### 参数错误

输入：

```ts
timezone: "Mars/Beijing"
```

结果：

```ts
{
  ok: false,
  content: "获取当前时间失败：Invalid time zone specified: Mars/Beijing",
  error: "Invalid time zone specified: Mars/Beijing",
  toolName: "get_current_time"
}
```

说明工具自己的 `try/catch` 正常。

## 10. 本次踩过的点

### ToolResult 拼写

曾写成：

```ts
TollResult
```

应改为：

```ts
ToolResult
```

### ToolExecutionResult 命名

曾写成：

```ts
ToolExecuteResult
```

推荐：

```ts
ToolExecutionResult
```

因为 `Execution` 是名词，更适合作为类型名。

### input_schema 拼写

曾写成：

```ts
input_scheme
```

应改为：

```ts
input_schema
```

### listForModel 拼写

曾写成：

```ts
listForModal
```

应改为：

```ts
listForModel
```

`model` 是模型，`modal` 是弹窗。

### 文件名 builtin.ts

曾写成：

```text
builti.ts
```

应改为：

```text
builtin.ts
```

### current-time.ts 命名

曾创建：

```text
current_time.ts
```

后改成：

```text
current-time.ts
```

更符合项目里常见的 kebab-case 文件命名。

## 11. 当前学习成果

你已经理解并亲手实现了：

```text
ToolDefinition：工具定义
ToolCall：一次工具调用请求
ToolResult：工具自己的执行结果
ToolExecutionResult：Router 包装后的执行结果
ToolRegistry：工具注册表
ToolRouter：工具执行路由
riskLevel：安全等级控制
parseInput：模型参数清洗
input_schema：给模型看的参数说明
```

## 12. 下一步

下一步可以开始接入 `/api/chat`：

```text
用户问：现在几点？
  -> 模型选择 get_current_time
  -> 后端执行工具
  -> 把 tool_result 发回模型
  -> 模型生成最终回答
```

在接代码前，建议先学习：

```text
Anthropic Tool Use / Tool Result 的消息结构
```

这样再接 API 会更清楚。
