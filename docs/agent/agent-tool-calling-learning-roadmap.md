# Agent 工具调用学习路线图

> 面向 Agent 初学者。目标是从普通聊天系统逐步理解并实现 Tool Use、Tool Registry、Tool Router、Agent Loop、安全沙箱和前端工具过程展示。

---

## 0. 总览

Agent 工具调用的核心流程是：

```text
用户输入
  ↓
模型判断是否需要工具
  ↓
模型输出 tool_use
  ↓
后端执行工具
  ↓
后端返回 tool_result
  ↓
模型基于结果继续推理
  ↓
输出最终答案
```

一句话理解：

> 模型负责决定调用什么工具，后端负责安全执行工具，模型再根据工具结果继续回答。

---

## 1. 阶段 0：理解普通聊天系统

普通聊天系统流程：

```text
前端收集 messages
  ↓
POST /api/chat
  ↓
后端调用 LLM
  ↓
LLM 返回文本
  ↓
前端展示文本
```

需要掌握：

- **Message**：对话消息，通常包含 `role` 和 `content`
- **Role**：常见有 `user`、`assistant`、`system`
- **Streaming**：模型一段一段返回内容，前端边收边显示

推荐先看当前项目：

- `lib/chat/chat-session.ts`
- `app/api/chat/route.ts`

学习目标：

```text
能解释用户发送一条消息后，前端和后端分别发生了什么。
```

---

## 2. 阶段 1：理解 Tool 是什么

Tool 本质上是后端暴露给模型使用的函数。

常见工具：

```text
read_file
list_directory
search_files
run_command
query_notion
save_memory
search_memory
```

一个工具通常有四个核心字段：

```ts
interface Tool {
  name: string;
  description: string;
  input_schema: object;
  execute(input: unknown): Promise<ToolResult>;
}
```

字段含义：

- **`name`**：工具名，例如 `read_file`
- **`description`**：写给模型看的工具说明
- **`input_schema`**：工具参数结构，通常是 JSON Schema
- **`execute`**：后端真正执行工具的函数

示例：

```ts
const getCurrentTimeTool = {
  name: "get_current_time",
  description: "获取当前服务器时间",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute() {
    return new Date().toISOString();
  },
};
```

学习目标：

```text
能说清楚一个工具叫什么、什么时候用、需要什么参数、后端执行什么。
```

---

## 3. 阶段 2：理解 Tool Registry

Tool Registry 是工具注册表。

```text
Tool Registry
├── read_file
├── list_directory
├── search_files
├── get_current_time
└── query_notion
```

它解决的问题是：

```text
模型返回工具名后，后端能根据工具名找到对应工具并执行。
```

最小能力：

```ts
class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }
}
```

学习目标：

```text
理解为什么不能把所有工具写成 if/else，而要统一注册和查找。
```

---

## 4. 阶段 3：理解模型如何请求工具调用

模型不会直接执行工具，只会返回结构化请求。

Anthropic Tool Use 示例：

```json
{
  "type": "tool_use",
  "id": "toolu_123",
  "name": "read_file",
  "input": {
    "path": "app/page.tsx"
  }
}
```

字段含义：

- **`type`**：`tool_use` 表示这是工具调用请求
- **`id`**：工具调用 ID，用于匹配结果
- **`name`**：工具名
- **`input`**：工具参数

学习目标：

```text
tool_use 不是工具结果，而是模型提出的工具调用请求。
```

---

## 5. 阶段 4：理解后端如何执行工具

当模型返回：

```json
{
  "type": "tool_use",
  "name": "read_file",
  "input": {
    "path": "app/page.tsx"
  }
}
```

后端执行：

```ts
const tool = registry.get("read_file");
const result = await tool.execute({ path: "app/page.tsx" });
```

执行结果不能直接结束，还需要包装成 `tool_result` 回传给模型。

---

## 6. 阶段 5：理解 Tool Result

`tool_result` 是后端返回给模型的工具执行结果。

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_123",
  "content": "文件内容..."
}
```

`tool_use_id` 用来告诉模型：

```text
这个结果对应哪一次工具调用。
```

这在模型一次请求多个工具时尤其重要。

---

## 7. 阶段 6：理解 Agent Loop

普通聊天是：

```text
调用一次模型 → 得到答案
```

工具调用是：

```text
调用模型 → 模型要工具 → 执行工具 → 再调用模型 → 得到答案
```

如果模型需要多个工具，就形成 Agent Loop：

```text
调用模型
  ↓
模型请求 read_file
  ↓
执行 read_file
  ↓
回传结果
  ↓
再调用模型
  ↓
模型请求 search_files
  ↓
执行 search_files
  ↓
回传结果
  ↓
再调用模型
  ↓
模型最终回答
```

伪代码：

```ts
let messages = userMessages;

for (let i = 0; i < maxIterations; i++) {
  const response = await callLLM({
    messages,
    tools,
  });

  messages.push(response.assistantMessage);

  if (response.stop_reason !== "tool_use") {
    return response.finalText;
  }

  const toolUses = extractToolUses(response);
  const toolResults = await executeTools(toolUses);

  messages.push({
    role: "user",
    content: toolResults,
  });
}
```

必须设置 `maxIterations`，防止模型无限循环调用工具。

---

## 8. 阶段 7：理解工具安全

Agent 工具调用最大的风险是：

```text
模型会决定调用工具，后端会真的执行。
```

必须防护：

- **路径穿越**：禁止 `../../../../.ssh/id_rsa`
- **敏感文件读取**：禁止 `.env`、`*.pem`、`*.key`、`credentials.json`
- **工作区外访问**：只能访问项目目录内部
- **大文件读取**：限制读取字符数、行数、搜索结果数
- **写操作误伤**：写文件必须审批
- **命令执行风险**：命令工具必须白名单、超时、审批

推荐权限分级：

```text
safe      → 只读工具，可以自动执行
confirm   → 写文件、编辑文件、跑命令，需要用户确认
dangerous → 高危路径、高危命令，直接拒绝
```

---

## 9. 阶段 8：第一版只做只读工具

推荐第一版只做：

```text
read_file
list_directory
search_files
```

### read_file

用途：读取文件内容。

输入：

```json
{
  "path": "app/page.tsx",
  "offset": 1,
  "limit": 120
}
```

### list_directory

用途：查看目录结构。

输入：

```json
{
  "path": "app"
}
```

### search_files

用途：搜索文件内容。

输入：

```json
{
  "query": "saveAssistantMessage",
  "path": "lib"
}
```

第一版暂时不要做：

```text
write_file
edit_file
run_command
```

---

## 10. 阶段 9：理解 Tool Use 和 RAG 的区别

| 能力 | 谁决定 | 过程是否显式 | 适合场景 |
|---|---|---|---|
| RAG | 后端自动检索 | 通常不显式 | 知识问答 |
| Tool Use | 模型主动选择 | 显式 tool_use/tool_result | 做任务、查文件、调用 API |
| Agent Loop | 模型多轮调用工具 | 显式多步过程 | 复杂任务 |

RAG 更像：

```text
后端自动帮模型找资料。
```

Tool Use 更像：

```text
模型主动决定我要查什么、调用什么。
```

---

## 11. 阶段 10：前端工具过程展示

第一版可以只返回最终答案。

更好的体验是展示工具过程：

```text
🔧 调用 read_file
路径：app/page.tsx

✅ 工具完成
读取 210 行
```

后续可以做成结构化卡片：

```text
[Tool Call]
read_file
path: app/page.tsx

[Tool Result]
文件内容预览...
```

价值：

- 用户知道 Agent 做了什么
- 用户能发现错误工具调用
- 方便调试
- 为写操作审批做铺垫

---

## 12. 推荐实战顺序

结合当前项目，建议按这个顺序实现：

```text
1. 定义 Tool 类型
2. 实现 Tool Registry
3. 实现一个假工具 get_current_time
4. 实现只读文件工具 read_file / list_directory / search_files
5. 实现 Tool Router
6. 接入 /api/chat，让模型能看到 tools
7. 支持一轮 tool_use → tool_result → final answer
8. 支持多轮 Agent Loop，限制最大轮数
9. 前端展示工具过程
10. 加权限层和审批流
11. 再做 write_file / edit_file
12. 最后做 run_command / MCP / 多 Agent
```

---

## 13. 当前项目建议文件结构

```text
lib/agent/
├── tools/
│   ├── types.ts
│   ├── registry.ts
│   ├── builtin.ts
│   ├── file-tools.ts
│   └── sandbox.ts
├── runtime/
│   ├── agent-loop.ts
│   └── tool-router.ts
└── streaming/
    └── events.ts
```

第一版可以只建：

```text
lib/agent/tools/types.ts
lib/agent/tools/registry.ts
lib/agent/tools/file-tools.ts
lib/agent/tools/sandbox.ts
```

---

## 14. 你需要掌握的关键词

按顺序理解：

```text
Message
Role
Streaming
Tool
JSON Schema
Tool Registry
Tool Router
tool_use
tool_result
Agent Loop
max_iterations
Sandbox
Permission
Approval
Tool Card
RAG
Memory
MCP
Multi-Agent
Harness
```

---

## 15. 最小闭环图

```text
┌──────────────┐
│    User      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  /api/chat   │
└──────┬───────┘
       │ messages + tools
       ▼
┌──────────────┐
│     LLM      │
└──────┬───────┘
       │
       ├──────────────► 普通文本回答
       │
       └──────────────► tool_use
                         │
                         ▼
                  ┌──────────────┐
                  │ Tool Router  │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ Tool Execute │
                  └──────┬───────┘
                         │ tool_result
                         ▼
                  ┌──────────────┐
                  │     LLM      │
                  └──────┬───────┘
                         │
                         ▼
                  最终回答给用户
```

---

## 16. 最终学习目标

学完并实现第一版后，你应该能做到：

```text
用户：帮我看看 app/api/chat/route.ts 是怎么处理 RAG 的

Agent：
1. 判断需要读取文件
2. 调用 read_file
3. 拿到 route.ts 内容
4. 基于真实代码解释逻辑
```

这就是从普通聊天助手进化到 Agent 的第一步。
