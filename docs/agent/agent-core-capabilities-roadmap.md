# Agent 核心能力实现路线图

> 本文不是泛泛的学习计划（那份在 [agent-learning-plan.md](./agent-learning-plan.md)），而是**针对当前项目运行时的真实缺口**，按"对理解 Agent 帮助最大"排序的核心能力清单。
>
> 每个能力都包含：**要学什么 / 为什么重要 / 当前缺口（指向真实代码）/ 实现步骤 / 完成标准 / 面试视角**。
>
> 建议严格按顺序做，因为后面的能力依赖前面建立的结构。

---

## 当前项目已具备（不用重复造）

| 能力 | 位置 | 状态 |
|---|---|---|
| Agent Loop（多轮工具调用） | [runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop` | ✅ |
| Tool Registry / Router | [registry.ts](../../lib/agent/tools/registry.ts) / [tool-router.ts](../../lib/agent/tools/tool-router.ts) | ✅ |
| 风险等级 + 限流 + 超时 | tool-router.ts | ✅ |
| RAG（作为工具） | [search-notes.ts](../../lib/agent/tools/search-notes.ts) | ✅ |
| 流式 + 文本 marker 协议 | route.ts / chat-session.ts | ✅ |
| 会话持久化 | [session-manager.ts](../../lib/chat/session-manager.ts) | ✅ |
| 危险工具人类确认 | tool-router.ts + confirm route | 🟡 半成品 |

**一句话判断当前水平**：你已经能让 Agent"多步执行 + 调工具 + 查知识库"，但 Agent 的"上下文/记忆/可观测/自我规划"几乎为零——而这四样才是 Agent 区别于"循环调函数"的核心。

---

## 排序总览（按学习价值）

```text
能力 1：上下文与 Token 预算管理      ⭐⭐⭐  最高，是其他一切的地基
能力 2：长期记忆（Memory）           ⭐⭐⭐  让 Agent 跨会话"认识你"
能力 3：可观测性（Trace / 日志 / Eval）⭐⭐⭐  没有它你无法判断 Agent 好坏
能力 4：结构化事件协议（替代文本 marker）⭐⭐  工程质量分水岭
能力 5：规划 / 子任务分解（Planning）  ⭐⭐  从"反应式"到"目标驱动"
能力 6：运行时类型收紧（去 any）      ⭐    重构，巩固理解
能力 7：MCP 接入外部工具             ⭐    生态视野
```

---

## 能力 1：上下文与 Token 预算管理 ⭐⭐⭐

### 要学什么
- 模型是**无状态**的，每轮能力上限完全由你塞进 context window 的内容决定。
- `loopMessages` 在你的 loop 里是**只增不减**的——多轮工具后会无限膨胀。
- Token 预算（budget）、上下文裁剪（truncation）、工具结果压缩（compaction）。

### 为什么这是第一位
你的 [runtime/index.ts:226](../../lib/agent/runtime/index.ts) 每轮都 `appendToolResults`，`loopMessages` 单调增长。一旦工具结果很大（比如 `search_notes` 返回长文档），或轮数变多，你会：
1. 超出模型 context 限制 → 直接报错；
2. 成本失控（你的 `costPerUse` 字段目前根本没人统计）；
3. 模型被早期无关内容淹没 → 决策变差。

这是真实生产 Agent 的**头号工程问题**，理解它你才算入门 Agent 而不是"调 API"。

### 当前缺口（真实代码）
- [runtime/index.ts](../../lib/agent/runtime/index.ts) 没有任何 token 计数、没有上限、没有截断。
- 工具结果 `toolResult.content` 直接整段塞回 messages，无长度限制。
- `costPerUse` / `durationMs` 算出来了但从未汇总。

### 实现步骤
1. 写一个 `lib/agent/runtime/budget.ts`：
   - `estimateTokens(messages)`（先用粗略估算：字符数 / 4，够学习用）；
   - `TokenBudget` 类：`max`、`spent`、`remaining()`、`canAfford(n)`。
2. 在 `runAgentLoop` 每轮调用模型前检查预算，超了就 break 进兜底总结（你已有这条兜底路径）。
3. 工具结果截断：超过 N tokens 的 `content` 截断并加 `…（已截断，原 X 字符）`。
4. （进阶）上下文压缩：当 `loopMessages` 超过阈值，把**早期的** tool_use/tool_result 对压缩成一句摘要，保留最近 K 轮原文。
5. 把每轮 token / 成本累加，最终通过新 marker 或日志输出。

### 完成标准
- 故意构造一个会触发 5+ 轮、每轮返回大结果的请求，loop 不会爆 context。
- 能打印出"本次请求总 token / 总成本 / 各工具耗时"。

### 面试视角
> Q：Agent 的上下文太长怎么办？
> A：三层策略——(1) 硬上限 + token 预算，超了就停并兜底总结；(2) 工具结果截断，避免单个大结果挤占 context；(3) 滚动压缩，把早期轮次摘要化、保留最近 K 轮原文。核心认知是模型无状态，context 是唯一的"工作记忆"，必须当成有限资源来管理。

---

## 能力 2：长期记忆（Memory） ⭐⭐⭐

### 要学什么
- 短期记忆（单次 loop 的 `loopMessages`）vs 会话记忆（你的 DB messages）vs **长期记忆**（跨会话的用户偏好/事实）。
- 记忆的两个动作：**写入**（什么值得记）和 **召回**（recall，什么时候取回来塞进 context）。
- 记忆 ≠ 把所有历史都塞进去，而是"按相关性取回少量关键事实"。

### 为什么重要
现在每次新会话，Agent 对你一无所知。真正的"personal assistant"必须记住"用户在刷 LeetCode 热题 100""用户偏好中文""用户在学 Agent 开发"。这是产品价值，也是理解 Agent"状态"的关键。

### 当前缺口
- 完全没有跨会话记忆层。`sessions` / `messages` 表只存对话流水。
- 你已有 pgvector + embedding（RAG 用），**记忆召回可以复用同一套基础设施**——这是绝佳的学习连接点。

### 实现步骤
1. 建一张 `memories` 表：`id, content, type(preference|fact|task), embedding, created_at`。
2. 写两个工具（让模型自己决定何时用，符合你现有的 tool 范式）：
   - `remember(content, type)`：写入一条记忆（建议设为 `confirm` 风险，练习人类确认闭环）；
   - `recall(query)`：向量检索相关记忆。
3. （进阶，更像真 Agent）在 `runAgentLoop` 启动前**自动召回**：用用户最新一条消息做向量检索，把 top-K 记忆作为 system 注入，而不是等模型主动调 `recall`。对比两种方式的差异——这是"被动工具"vs"主动记忆"的核心区别。

### 完成标准
- 会话 A 说"我在准备字节面试"，会话 B 问"给我出道题"时，Agent 能结合这条记忆。
- 能解释"主动召回"和"工具式召回"各自的优劣。

### 面试视角
> Q：Agent 怎么实现长期记忆？
> A：记忆是"写入 + 召回"两个独立问题。写入要判断什么值得记（偏好、稳定事实，而非一次性闲聊）；召回不是塞全部历史，而是用向量检索按相关性取回少量记忆注入 context。我项目里记忆和 RAG 复用同一套 embedding + pgvector，区别在于 RAG 检索的是外部知识，记忆检索的是关于用户自身的事实。

---

## 能力 3：可观测性（Trace / 结构化日志 / Eval） ⭐⭐⭐

### 要学什么
- 一次 Agent 请求是一棵**调用树**：每轮模型调用、每个工具调用、token、耗时、成败。
- Trace（把一次请求的所有步骤串成结构化记录）。
- Eval（测试集 + 期望工具/结果，自动判断 Agent 是否退化）。

### 为什么重要
你的运行时现在只有零散 `console.log`（如 tool-router 的 `[RateLimit]`、chat-session 的 `xxxx`）。**你无法回答"这次为什么慢/为什么调错工具/比上周变差了吗"**。Agent 不能靠手测，这是从"玩具"到"可维护系统"的分界。

### 当前缺口
- 无统一 trace 结构，`metadata` 里散落了 `durationMs` 但没人聚合。
- 无 eval 用例（你的 learning-plan 第 7 阶段提到要 20 条，但还没建）。
- `scripts/test-tool-call.ts` 是手动脚本，不是可重复的 eval。

### 实现步骤
1. 定义 `AgentTrace` 类型：`requestId, steps[]`，每个 step 是 `{ type: "model"|"tool", name, input, output, tokens, durationMs, ok }`。
2. 在 `runAgentLoop` 里收集每一步到 trace，请求结束打印一棵树（或写 DB / 文件）。
3. 建 `lib/agent/eval/`：
   - `cases.ts`：`{ prompt, expectedTool?, assert(result) }[]`，先写 10 条。
   - `run.ts`：跑全部用例，输出"通过率 / 误调用 / 平均耗时 / token"。
4. （进阶）用 LLM-as-judge 给开放式回答打分。

### 完成标准
- 一条命令跑 eval，输出表格：用例 / 期望工具 / 实际工具 / 是否通过 / 耗时 / token。
- 改了 prompt 或 loop 后，能用 eval 验证没退化。

### 面试视角
> Q：你怎么知道 Agent 好不好？
> A：两层——线上用 trace 把每次请求记录成结构化调用树（每轮模型/工具的输入输出、token、耗时、成败），离线用 eval 集回归（prompt → 期望工具/结果 → 自动断言）。没有这两样，Agent 的"变好变坏"完全靠感觉，无法迭代。

---

## 能力 4：结构化事件协议（替代文本 marker） ⭐⭐

### 要学什么
- 你现在的前后端协议是把 `__TOOL_CALL__ … __END_TOOL_CALL__` 字符串混在文本流里（见 [chat-session.ts:121-179](../../lib/chat/chat-session.ts)）。
- SSE / NDJSON 事件流：每个事件有明确 `type`，前端按类型分发，不靠字符串切割。

### 为什么重要
文本 marker 的脆弱点你自己在面试总结里也写了（第 7 节）：依赖分隔符、模型若吐出相似字符串会污染、解析逻辑复杂（chat-session 里那段 while 循环很脆）。升级成结构化事件是真实 Agent 前端的标准做法，能让你理解"流式 + 结构化"如何共存。

### 当前缺口
- [runtime/index.ts:146](../../lib/agent/runtime/index.ts) 拼字符串 marker。
- [chat-session.ts:125-203](../../lib/chat/chat-session.ts) 用 `indexOf` 手工切割三种 marker，逻辑脆弱。

### 实现步骤
1. 定义事件类型：`{ type: "text"|"tool_call"|"tool_result"|"sources"|"error"|"done", ... }`。
2. 后端每个事件 `JSON.stringify` 后用 `\n` 分隔（NDJSON），`enqueueText` 改 `enqueueEvent`。
3. 前端按行解析 JSON，按 `type` 分发到 `content` / `toolCalls` / `sources` / `error`。
4. 删掉 chat-session 里的 marker 切割逻辑。

### 完成标准
- 工具调用过程、来源、错误都走结构化事件，前端不再做字符串 `indexOf` 切割。
- 模型输出里即使出现 `__TOOL_CALL__` 字面量也不会污染解析。

### 面试视角
> Q：流式响应里怎么同时传文本和工具调用过程？
> A：早期我用文本 marker 混在流里，简单但脆——依赖分隔符、可被模型输出污染。后来升级为 NDJSON 事件流，每个事件带 type，前端按类型分发。这样流式实时性和结构化可解析性兼得。

---

## 能力 5：规划 / 子任务分解（Planning） ⭐⭐

### 要学什么
- 当前 loop 是**反应式**的：模型每轮只看上一步结果决定下一步，没有全局计划。
- 显式 Planning：先让模型产出一个 plan（步骤列表），再逐步执行、可勾选完成。
- 这是 Claude Code 的 TodoWrite、各类 Planner-Executor 架构的核心思想。

### 为什么重要
反应式 loop 在长任务上容易"走偏 / 遗漏步骤"。显式计划让 Agent 从"走一步看一步"变成"目标驱动 + 可追踪进度"，也是 Multi-Agent（你 learning-plan 第 4 阶段）的前置认知。

### 当前缺口
- `runAgentLoop` 无任何 plan 概念，纯反应式。

### 实现步骤
1. 加一个 `create_plan(steps)` 工具或在 loop 开头让模型先输出计划。
2. 维护 plan 状态（pending/in_progress/done），每完成一步更新。
3. 通过结构化事件（能力 4）把 plan 进度推给前端展示。
4. （进阶）对比"有计划"vs"无计划"在一个多步任务上的表现差异。

### 完成标准
- 给一个明确多步任务（如"研究 Agent Memory 并写笔记存到知识库"），Agent 先出计划再执行，前端能看到进度。

### 面试视角
> Q：反应式 Agent 和有计划的 Agent 区别？
> A：反应式每轮只基于上一步结果决策，简单但长任务易走偏；显式 Planning 先分解目标为步骤再逐步执行，进度可追踪、可中断恢复。但要遵守"单 Agent 能解决就不上 Planner"的原则，别过度设计。

---

## 能力 6：运行时类型收紧（去 any） ⭐

### 要学什么
你的 [runtime/index.ts:5-7](../../lib/agent/runtime/index.ts) `type ModelMessage = any` 等一片 `any`。用 Anthropic SDK 的真实类型替换，理解 content block 的判别联合类型（`type: "text" | "tool_use" | ...`）。

### 为什么重要
属于"重构巩固"——在收紧类型的过程中，你会被迫真正读懂每个 block 的结构，反过来加深对 Agent Loop 数据流的理解。学习价值低于前面，但成本也低。

### 实现步骤
1. 用 `Anthropic.MessageParam` / `ContentBlock` / `ToolUseBlock` 替换 `any`。
2. `extractToolUses` 用类型守卫收窄。
3. `npm run build` 通过。

### 完成标准
- runtime 里关键路径无 `any`，build 通过。

---

## 能力 7：MCP 接入外部工具 ⭐

### 要学什么
- MCP（Model Context Protocol）：让外部进程暴露工具/资源，Agent 动态接入。
- 你的 `ToolRegistry` 是"内部工具表"，MCP 是"把外部工具也注册进同一张表"。

### 为什么重要
理解 Agent 生态如何横向扩展。学习价值排最后，因为它更多是"接生态"而非"理解原理"——前 6 个能力才是 Agent 的内核。

### 实现步骤
1. 跑通一个现成 MCP server（如 filesystem / fetch）。
2. 写一个适配层，把 MCP tool 转成你的 `ToolDefinition` 注册进 `ToolRegistry`。
3. 让 MCP 工具也走你的风险/限流/超时/trace 体系。

### 完成标准
- 一个外部 MCP 工具能像内部工具一样被模型调用，并受同样的权限和 trace 约束。

---

## 推荐节奏

```text
第 1 步：能力 1（上下文/预算）   —— 地基，先做
第 2 步：能力 3（可观测/Eval）   —— 先有度量，后面改动才有反馈
第 3 步：能力 2（长期记忆）       —— 复用 RAG 基建，产品价值高
第 4 步：能力 4（结构化协议）     —— 工程质量，配合能力 5 展示进度
第 5 步：能力 5（Planning）       —— 进阶到目标驱动
第 6 步：能力 6（类型）/ 能力 7（MCP）—— 收尾巩固 + 拓展生态
```

> 说明：把"可观测/Eval"提到第 2 步（早于记忆），是因为后面每个能力的改动都需要 eval 来验证没退化——**先有尺子，再改东西**。

---

## 每实现一个能力的产出要求

遵循 [README.md](../README.md) 的笔记模板，每个能力完成后：

1. 在 `docs/agent/` 写一份实战笔记（解决什么问题 / 核心概念 / 关键代码走读 / 决策权衡 / 踩坑）。
2. 更新 [README.md](../README.md) 索引表 和 [docs-catalog.md](../docs-catalog.md) 分类表。
3. 补一条 eval 用例（能力 3 建好后）。

---

## 延伸阅读

- Anthropic: Building effective agents（反应式 vs 工作流 vs Agent）
- Anthropic: Effective context engineering / context management
- 你已有的 [agent-loop-interview-summary.md](./agent-loop-interview-summary.md) 第 13 节"后续演进方向"——本路线图正是它的展开和重新排序。
