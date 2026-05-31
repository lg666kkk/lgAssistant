# Agent Loop 面试总结

> 本文从面试官和面试者两个视角，总结当前项目里的 Agent Loop 实现。目标不是背概念，而是能讲清楚“为什么需要 Agent Loop、它怎么跑、边界在哪里、如何防止失控”。

---

## 1. 一句话概括

Agent Loop 是一个“模型推理 -> 工具执行 -> 工具结果回灌 -> 再次推理”的循环。

在当前项目里，它让助手不再只是“调用一次工具后回答”，而是可以在一次用户请求中连续完成多步任务，例如：

```text
用户：先算 123*456，再告诉我现在几点

第 1 轮：模型请求 calculator
第 2 轮：模型拿到计算结果后请求 get_current_time
第 3 轮：模型拿到时间结果后生成最终回答
```

---

## 2. 当前项目中的核心文件

| 文件 | 职责 |
|---|---|
| `app/api/chat/route.ts` | HTTP API 入口，负责请求校验、创建 `ReadableStream`、转发响应、关闭流 |
| `lib/agent/runtime/index.ts` | Agent Runtime，负责模型调用、Agent Loop、工具执行、工具结果回灌、重复工具调用保护 |
| `lib/agent/tools/registry.ts` | Tool Registry，负责注册和查找工具 |
| `lib/agent/tools/tool-router.ts` | Tool Router，负责执行工具并处理权限风险 |
| `lib/agent/tools/*` | 具体工具实现，例如计算器、当前时间、笔记搜索、LeetCode 练习 |

---

## 3. Agent Loop 整体流程

```text
用户输入
  ↓
POST /api/chat
  ↓
创建 Tool Registry
  ↓
创建 ReadableStream
  ↓
runAgentLoop
  ↓
调用模型 callModel
  ↓
模型返回 content blocks
  ↓
提取 tool_use
  ├─ 没有 tool_use：输出最终文本，结束
  └─ 有 tool_use：执行工具
        ↓
      生成 tool_result
        ↓
      把 assistant tool_use + user tool_result 追加回 loopMessages
        ↓
      继续下一轮模型调用
```

当前实现使用 `for (let i = 0; i < maxToolIterations; i++)`，它本质上是一个带最大轮数保护的 `while`。

---

## 4. 为什么不是只调用一次工具

单轮工具调用只能处理：

```text
用户问题 -> 模型调用工具 -> 工具返回 -> 模型回答
```

但真实任务经常需要多步：

```text
先查资料 -> 再计算 -> 再创建待办 -> 最后总结
```

Agent Loop 的价值在于：模型每拿到一次工具结果，都可以继续判断下一步是否还需要工具。

---

## 5. 关键数据结构

### 5.1 loopMessages

`loopMessages` 是 Agent Loop 的上下文状态。

它一开始来自前端传入的历史消息：

```ts
let loopMessages = [...messages];
```

每执行一轮工具后，会追加两条消息：

```ts
[
  {
    role: "assistant",
    content: assistantResponse.content,
  },
  {
    role: "user",
    content: toolResultBlocks,
  },
]
```

这一步很关键。模型下一轮必须看到：

```text
我刚才请求了什么工具
后端执行后的结果是什么
```

否则模型可能重复调用同一个工具。

### 5.2 tool_use

`tool_use` 是模型发出的工具请求。

它通常包含：

```ts
{
  type: "tool_use",
  id: "tool_xxx",
  name: "calculator",
  input: {
    expression: "123 * 456"
  }
}
```

模型不直接执行工具，只负责提出结构化请求。

### 5.3 tool_result

`tool_result` 是后端执行工具后返回给模型的结果。

```ts
{
  type: "tool_result",
  tool_use_id: toolUse.id,
  content: toolResult.content,
  is_error: !toolResult.ok,
}
```

`tool_use_id` 必须和模型发出的 `tool_use.id` 对上，这样模型才能知道结果对应哪一次工具调用。

---

## 6. 当前实现的关键函数

### 6.1 runAgentLoop

`runAgentLoop` 是核心循环。

它负责：

- 调用模型
- 提取文本和工具调用
- 判断是否结束
- 检测重复工具调用
- 执行工具
- 把工具结果追加回上下文
- 返回是否完成

核心语义：

```ts
type AgentLoopResult = {
  loopMessages: ModelMessage[];
  completed: boolean;
};
```

`completed: true` 表示模型已经给出最终文本，API 可以关闭流。

`completed: false` 表示还没有自然结束，例如达到最大工具轮数或检测到重复工具调用，外层需要做兜底总结。

### 6.2 callModel

`callModel` 只负责一次非流式模型调用。

它不执行工具，不解析结果，不控制循环。

### 6.3 executeTools

`executeTools` 负责执行当前轮模型请求的所有工具。

它返回：

```ts
{
  toolResultBlocks,
  toolSources,
  toolMarkers,
}
```

- `toolResultBlocks`：给模型看的工具结果
- `toolSources`：给前端展示来源
- `toolMarkers`：给前端解析工具调用过程

### 6.4 streamModelResponse

当 Agent Loop 达到最大轮数或需要兜底总结时，用它做最终流式回答。

### 6.5 forwardTextStream

负责把模型流里的 text delta 转发给前端。

---

## 7. 前后端私有协议

当前项目把工具调用过程通过文本 marker 混在流式响应里发给前端。

工具调用 marker：

```text
__TOOL_CALL__
{"name":"calculator","input":{"expression":"123*456"},"ok":true}
__END_TOOL_CALL__
```

来源 marker：

```text
__SOURCES__
[{"title":"xxx","pageUrl":"xxx"}]
```

错误 marker：

```text
__ERROR__
{"error":"流式响应中断","message":"..."}
```

这是一种简单有效的私有协议。优点是前端不用切换到复杂的 SSE event 类型；缺点是协议依赖字符串分隔符，后续可以升级为结构化 event stream。

---

## 8. 为什么要防重复工具调用

Agent Loop 最大的风险是模型陷入循环。

例如：

```text
第 1 轮：calculator({ expression: "123*456" })
第 2 轮：calculator({ expression: "123*456" })
第 3 轮：calculator({ expression: "123*456" })
```

当前项目通过 `seenToolCalls` 防重复：

```ts
const key = JSON.stringify({
  name: toolUse.name,
  input: toolUse.input,
});
```

如果后续轮次再次出现同样的 `{ name, input }`，就停止继续执行工具，交给外层基于已有结果总结。

注意：

```text
用户输入重复 ≠ 工具调用重复
```

重复保护防的是模型在 loop 中卡住，不是防用户说了两遍同一个问题。

---

## 9. 为什么用 for 而不是 while true

教程里常见：

```ts
while (true) {
  ...
}
```

这是为了表达“直到模型不再需要工具”。

当前项目用：

```ts
for (let i = 0; i < maxToolIterations; i++) {
  ...
}
```

这是工程上更安全的写法，因为最大轮数一眼可见，不容易忘记退出条件。

两者本质一样：

```text
while true + 手动 break + 最大轮数保护
≈
for + 最大轮数天然保护
```

---

## 10. 面试官会问什么

### Q1：什么是 Agent Loop？

面试官想听到：

- 不只是一次模型调用
- 模型可以调用工具
- 工具结果会回灌给模型
- 模型基于结果继续决策
- 循环直到没有工具调用或达到终止条件

参考回答：

> Agent Loop 是让模型在一次用户请求中多轮推理和行动的执行循环。每一轮模型先基于上下文判断是否需要工具，如果需要，后端执行工具并把结果作为 `tool_result` 回填到上下文，然后模型继续推理。直到模型不再返回 `tool_use`，或者触发最大轮数、重复调用、用户中断等保护条件。

### Q2：为什么工具结果要放回 messages？

面试官想听到：

- 模型是无状态的
- 下一轮只能看到传进去的 messages
- 不回填就不知道工具已经执行
- 容易重复调用工具

参考回答：

> 模型本身不记得后端执行了什么。我们必须把上一轮 assistant 的 `tool_use` 和 user 的 `tool_result` 追加到 messages。这样下一轮模型才能知道“我刚才请求了某个工具，工具结果是这个”，然后基于结果继续回答或决定下一步。

### Q3：`tool_use` 和 `tool_result` 的关系是什么？

参考回答：

> `tool_use` 是模型发出的工具请求，包含工具名、参数和 id。`tool_result` 是后端执行工具后的结果，必须通过 `tool_use_id` 对应回原来的工具请求。这个配对关系保证模型知道每个结果来自哪一次工具调用。

### Q4：为什么要有最大工具调用轮数？

参考回答：

> 因为模型可能反复请求工具，尤其在工具失败、上下文不完整或模型误判时。最大轮数是 Agent Loop 的硬保护，避免请求无限执行、成本失控和用户等待过久。

### Q5：重复工具调用保护怎么做？

参考回答：

> 为每次工具调用生成稳定 key，例如 `{ name, input }` 的 JSON 字符串。每一轮执行前检查这个 key 是否已经出现过。如果出现过，说明模型可能卡住了，就停止继续执行工具，转为基于已有结果总结。

### Q6：为什么 route 里不直接写所有逻辑？

参考回答：

> route 应该只负责 HTTP 层：请求校验、创建响应流、处理中断和错误。Agent Loop、模型调用、工具执行属于 runtime 层。拆开以后更容易测试、复用，也更适合后续接入 Memory、RAG、权限系统和 MCP。

### Q7：Tool-based RAG 和 Agent Loop 是什么关系？

参考回答：

> Tool-based RAG 可以作为 Agent Loop 里的一个工具，例如 `search_notes`。模型在某一轮决定调用搜索工具，后端检索知识库，把结果作为 `tool_result` 回给模型，模型再基于检索结果回答。Agent Loop 负责让这个过程可以和其他工具连续组合。

### Q8：流式响应和 Agent Loop 怎么配合？

参考回答：

> 当前实现里，工具调用阶段主要是非流式模型调用，因为要先拿到完整的 `tool_use` block。工具执行过程通过 marker 流式发送给前端。最终文本可以通过模型 stream 转发给前端。这样兼顾了工具执行的结构化和最终回答的实时展示。

### Q9：当前实现还有什么不足？

参考回答：

> 主要不足包括：类型还比较粗，很多地方还是 `any`；前后端协议用文本 marker，后续可以升级为结构化事件；确认型工具还没有完整的人类审批闭环；重复调用保护比较简单，只按 `{ name, input }` 判断；还没有 token 预算和工具结果截断策略。

---

## 11. 面试者如何讲当前项目实现

可以按这个顺序讲：

1. 我们先有基础聊天 API，用户消息从前端发到 `/api/chat`。
2. 后端创建工具注册表，把工具 schema 传给模型。
3. `runAgentLoop` 维护一份 `loopMessages`。
4. 每轮调用模型，如果没有 `tool_use`，说明模型已经可以回答，直接输出文本并结束。
5. 如果有 `tool_use`，后端通过 Tool Router 执行工具。
6. 工具结果被转换为 `tool_result`，并追加回 `loopMessages`。
7. 同时工具调用过程通过 `__TOOL_CALL__` marker 发给前端展示。
8. 如果 `search_notes` 命中来源，会通过 `__SOURCES__` marker 给前端。
9. 循环最多执行 8 轮，并检测重复工具调用。
10. 如果达到上限或重复调用，就停止工具执行，基于已有上下文做兜底总结。

---

## 12. 当前实现的完成标准

Agent Loop 第一版完成的判断标准：

- 普通问题可以不调用工具直接回答
- 单工具问题可以调用工具后回答
- 多工具问题可以连续调用多个工具
- 工具结果会正确回灌给模型
- 工具调用过程能被前端展示
- 知识库搜索来源能返回给前端
- 重复工具调用能被拦截
- 达到最大工具轮数能兜底总结
- `npm run build` 通过

---

## 13. 后续演进方向

建议按这个顺序继续：

1. 完成 `confirm` 风险工具的人类确认闭环。
2. 收紧 runtime 类型，减少 `any`。
3. 把文本 marker 升级为结构化事件协议。
4. 增加工具结果截断和 token 预算。
5. 增加工具执行日志和审计记录。
6. 接入 Memory，让 Agent Loop 可以主动召回长期记忆。
7. 接入 MCP，让外部工具也进入 Tool Registry。

---

## 14. 面试中的高分表达

可以用这段总结：

> 这个 Agent Loop 的核心不是“让模型自动跑很多步”，而是把每一步都收进一个可控的工程闭环：模型只负责提出工具请求，后端负责权限检查和执行，工具结果必须回灌到上下文，循环必须有最大轮数、重复调用检测和用户中断处理。这样 Agent 才不是不可控的黑盒，而是一个可观测、可中断、可扩展的运行时。
