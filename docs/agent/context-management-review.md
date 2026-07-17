# Agent 上下文管理现状评估与改进建议

> 评估日期：2026-07-16  
> 评估依据：当前仓库运行时代码，不以已有路线图的结论作为判断依据。  
> 配套文档：[Agent 可观测性完善方案](./agent-observability-improvement-plan.md)

## 1. 结论

当前上下文管理已经超过“截取最近 N 条消息”的基础实现，形成了以下完整链路：

- 会话历史恢复；
- 长期记忆按需召回；
- Prompt 分段、优先级和总预算；
- Agent Loop 工作窗口控制；
- 语义压缩和确定性降级；
- 工具结果整形、截断和 artifact 按需读取；
- Context Usage 事件和 Trace 展示。

按成熟度判断：

| 维度 | 评分 | 判断 |
|---|---:|---|
| 单次 Agent Loop 防止上下文爆炸 | 4/5 | 预算、压缩、工具结果治理都已具备 |
| 上下文来源组织 | 3.5/5 | 已段化，但尚未形成统一 `ContextPlan` |
| 跨轮连续性 | 2.5/5 | 只恢复最近纯文本，压缩状态和工具状态不持久化 |
| 安全边界 | 2/5 | 用户原文进入 system，外部内容缺少统一污点边界 |
| 可解释与可评估 | 3/5 | 能看已注入内容，但看不到完整选择和淘汰过程 |

综合为 **3.5/5 的成熟原型上下文管理**；如果按企业级长任务、可恢复执行和安全治理标准衡量，约为 **2.5/5**。

## 2. 当前上下文链路

```text
客户端本轮消息
  |
  +-> Redis 会话历史
  |     \-> Redis 为空时从 Supabase 恢复最近 15 条
  |
  +-> 长期记忆召回
  |     \-> 仅在问题命中画像/历史意图时执行语义召回
  |
  +-> 知识库画像
  |     \-> 注入 search_notes 工具描述，帮助模型决定是否检索
  |
  +-> Prompt Pipe
  |     \-> 当前问题 / 身份 / 记忆 / 知识库策略 / 联网策略
  |
  +-> Planner 或 ReAct Agent Loop
        |
        +-> 请求前估算 messages + system + tool schemas
        +-> 超过工作窗口阈值时压缩中间历史
        +-> 模型调用
        +-> 工具结果整形、截断、artifact 化
        \-> 追加结果并进入下一轮
```

核心入口与职责：

| 模块 | 当前职责 |
|---|---|
| `app/api/chat/route.ts` | 恢复会话、召回记忆、组装 Prompt、选择 Planner/ReAct |
| `lib/agent/prompt/` | Prompt 段构造、排序、预算和渲染 |
| `lib/agent/runtime/index.ts` | Loop 预算、压缩触发、模型调用、工具结果回灌 |
| `lib/agent/runtime/compaction.ts` | 中间历史切分、语义摘要、确定性降级 |
| `lib/agent/runtime/tokenizer.ts` | 请求前 token 估算和按 token 截断 |
| `lib/agent/memory/memory-flow.ts` | 长期记忆召回和对话后沉淀 |
| `lib/agent/runtime/artifact-store.ts` | 保存不适合直接进入上下文的完整工具结果 |

## 3. 当前预算策略

### 3.1 会话历史

- 客户端通常只发送本轮用户消息；服务端按 `sessionId` 从 Redis 补历史。
- Redis 为空时从数据库恢复最近 15 条 user/assistant 纯文本消息。
- Redis 会话 TTL 为 2 小时，每次追加消息时刷新。
- 当前不会恢复 tool call、tool result、压缩摘要或未完成任务状态。

### 3.2 System Prompt

- 路由传入的全局预算为 4200 tokens。
- 当前段优先级由高到低大致为：当前问题、身份、知识、记忆、知识库策略、搜索策略、联网策略。
- Prompt Pipe 返回 `segments`、`omittedSegments` 和估算 token，但路由只把保留段写入 Trace。

### 3.3 Agent Loop

| 参数 | 当前值 | 含义 |
|---|---:|---|
| 累计调用预算 | 128000 tokens | 一次 Agent Loop 所有模型调用累计上限 |
| 输出预留 | 4096 tokens | 每次调用前为模型输出保留空间 |
| 工作窗口上限 | `min(modelWindow, 80000)` | 不直接吃满模型声明窗口 |
| 常规压缩触发点 | 工作窗口的 60% | 80K 工作窗口下约 48K |
| 压缩目标参数 | 工作窗口的 30% | 80K 工作窗口下约 24K |
| 原样保留 | 开头 3 条、最近 6 条 | 中间消息进入摘要 |
| 压缩频率限制 | 新增至少 8 条消息 | 避免每轮重复压缩 |

预算不足时会绕过压缩频率限制，强制压缩一次；如果仍不足，则以 `token_budget_exceeded` 结束工具循环。

### 3.4 工具结果

- `web_search` 最多保留 5 个结果，每个摘要约 500 字符；
- `search_notes` 最多保留 8 个结果，每个摘录约 700 字符；
- `web_fetch` 保留头尾片段，正文约 3500 字符；
- 常规工具结果最终限制在约 1200 tokens；
- `read_tool_artifact` 单次允许约 4000 tokens，并支持按 token 分页；
- 较大的网页、搜索和知识库结果保存为 artifact，模型上下文只保留引用和摘要。

## 4. 做得好的部分

### 4.1 使用真实 tokenizer 进行请求前估算

`lib/agent/runtime/tokenizer.ts` 使用 `gpt-tokenizer` 的 `o200k_base` 近似 DeepSeek token，失败后才退化到字符估算。相比固定字符除以四，这对结构化消息和工具 schema 更可靠。

### 4.2 同时限制窗口和累计费用

工作窗口解决“单次请求是否放得下”，`TokenBudget` 解决“Agent 多轮重复携带上下文造成的累计消耗”。二者职责分开是正确设计。

### 4.3 压缩具有语义路径和确定性降级

正常路径使用 `deepseek-v4-flash` 生成结构化摘要，要求保留目标、约束、决定、文件、工具结果和未解决问题；模型失败或返回空摘要时使用本地确定性摘要，避免压缩服务故障直接中断任务。

### 4.4 工具结果不是简单粗暴截尾

不同工具有独立整形策略，并把完整内容保存为 artifact。这样既控制上下文，又给模型保留了按需回读原文的能力。

### 4.5 已具备基础上下文可观测性

每次模型调用会记录估算上下文、真实 usage、剩余预算和 system segments；压缩步骤记录压缩前后 token、方法、摘要模型和降级原因，前端也能显示工作窗口占用。

## 5. 主要问题

### P0-1 用户原文被提升到 system 层

`buildSegments` 把最新用户消息原样放入 `task-context` system 段，同时消息本身仍以 user role 传给模型。

影响：

- 同一内容重复消耗 token；
- 用户可控指令进入更高优先级上下文；
- Prompt Injection 的角色边界变得模糊；
- Trace 中保存两份用户输入，扩大敏感数据暴露面。

建议：

- 当前问题只保留在 user message；
- system 只保存服务端可信策略；
- 如果需要强调“只回答最新问题”，只注入不包含用户原文的固定策略；
- 外部工具/RAG 内容使用明确的不可信数据 envelope，不能拼成 system 指令。

### P0-2 `tokenBudget` 不是单段硬上限

当前只有当全局预算不足时，才使用段自己的 `tokenBudget`。如果某个长记忆段仍能放入 4200 总预算，它可能超过声明的 500 token 上限。

同时，Prompt 段裁剪仍使用 `maxTokens * 4` 字符，对中文内容不准确，并且追加“已截断”后可能略微超过剩余预算。

建议采用两阶段算法：

1. 每段先按自己的 `tokenBudget` 使用 tokenizer 截断；
2. 再按优先级放入全局预算；
3. 记录每段 `originalTokens/keptTokens/truncated/omittedReason`；
4. 最终对渲染后的完整 system prompt 再计数校验。

### P0-3 压缩切分没有保护工具事务边界

压缩按照消息数量切分前段、中段、最近段，可能把 assistant 的 `tool_use` 和下一条 user `tool_result` 分到不同区域。摘要后保留下来的孤立 `tool_result` 可能失去对应调用，甚至形成 provider 不接受的消息序列。

建议先把消息归并为不可拆分单元：

- 普通 user/assistant turn；
- assistant tool calls + 对应全部 tool results；
- ask_user 问题 + 用户回答；
- plan step + step result。

压缩只能在单元之间切分。

### P1-1 压缩摘要没有跨请求持久化

压缩后的 `loopMessages` 只存在于当前请求。下一轮重新从 Redis/数据库恢复最近 15 条纯文本时，早期目标、工具证据、artifact 引用和未完成状态都会丢失。

建议增加 `ContextSnapshot`：

- `sessionId/runId/version`；
- 结构化摘要；
- 最近完整 turns；
- artifact references；
- unresolved items；
- summary source range 和 hash；
- 创建时使用的 Prompt/模型/策略版本。

下一轮应从 snapshot + 增量消息恢复，而不是只取最近 15 条文本。

### P1-2 Planner 和 Executor 看到的上下文不一致

Planner 只读取最新用户消息和工具名称；执行器则能看到会话历史、记忆和 system prompt。对于“继续刚才的方案”“按我的偏好调整”等问题，计划可能在缺少关键背景时生成。

建议建立独立 `PlannerContext`，只包含：

- 当前任务；
- 当前会话目标摘要；
- 最近必要 turns；
- 直接相关记忆；
- 可用工具能力摘要；
- 已完成步骤和未解决项。

Planner 与 Executor 应引用同一个 `contextSnapshotId`，但可以使用不同的视图和预算。

### P1-3 记忆沉淀看不到完整执行结果

路由调用 `consolidate(modelMessages)`，输入主要是请求消息，没有最终回答、工具结果和完整 `loopMessages`。这会导致长期记忆写入无法利用本轮新证据，也难以识别模型已纠正或否定的事实。

建议改为从“完整轮次结果”生成 `MemoryWriteCandidate`，输入至少包含用户消息、最终回答、关键工具证据和明确的用户修正；随后再执行 ADD/UPDATE/INVALIDATE/NOOP 决策。

### P1-4 压缩目标参数语义不一致

运行时把“期望压缩后的整体上下文目标”24K 作为“摘要目标长度”传给压缩模型，但模型输出又被硬限制为最多 2000 tokens。Prompt 会要求一个实际无法达到的目标长度。

建议拆成：

- `targetContextTokens`：压缩后整体上下文目标；
- `summaryTokenBudget`：摘要自身上限，例如 1200-2000；
- 压缩后重新计数；如果仍超过 `targetContextTokens`，执行第二级确定性裁剪。

### P1-5 上下文选择过程不可完全解释

当前 Trace 能看到最终保留的 system segments，却看不到：

- 历史来自客户端、Redis 还是数据库；
- 原始消息数和最终保留数；
- 记忆候选、分数和淘汰原因；
- 被省略的 Prompt 段；
- 每段压缩前后的 token；
- 工具 schema 在上下文中占用多少 token；
- 为什么选择压缩或跳过压缩。

这需要统一 `ContextPlan`，而不是继续向 `ModelTraceStep` 零散加字段。

### P2-1 策略全部硬编码在运行时

窗口上限、触发比例、保留消息数、Prompt 总预算和工具结果上限都是代码常量。不同模型、任务和租户不能独立调优，也无法从 Trace 还原“当时使用了哪版策略”。

建议引入版本化 `ContextPolicy`，按模型和任务类型选择，并把 `policyId/policyVersion` 写入 Trace。

### P2-2 压缩质量测试覆盖不足

当前压缩测试主要验证阈值和 force 模式，没有验证事实保真、工具事务、中文 token 边界、连续多次压缩和 Prompt Injection。

## 6. 目标 `ContextPlan`

建议把每次模型调用前的上下文决策固化为结构化对象：

```ts
type ContextPlan = {
  id: string;
  policy: { id: string; version: string };
  model: string;
  windowTokens: number;
  outputReserveTokens: number;
  sources: Array<{
    id: string;
    kind: "system" | "history" | "memory" | "rag" | "tool" | "artifact";
    trust: "trusted" | "user" | "external";
    priority: number;
    originalTokens: number;
    keptTokens: number;
    decision: "kept" | "truncated" | "summarized" | "omitted";
    reason?: string;
    contentHash: string;
  }>;
  totals: {
    systemTokens: number;
    messageTokens: number;
    toolSchemaTokens: number;
    totalTokens: number;
  };
  compaction?: {
    method: "semantic" | "deterministic";
    sourceRange: string;
    beforeTokens: number;
    afterTokens: number;
    summaryRef: string;
  };
};
```

`ContextPlan` 应成为 Planner、Executor、Trace、Eval 和 Replay 的共同契约。

## 7. 建议实施顺序

### 第一阶段：正确性与安全（1-2 天）

1. 移除 system 中的用户原文；
2. 修复单段预算和中文 token 裁剪；
3. 压缩按完整 turn/tool transaction 切分；
4. 增加对应单元测试和 injection case。

### 第二阶段：可解释上下文（2-3 天）

1. 引入最小 `ContextPlan`；
2. 记录历史来源、候选/保留数量、segment 决策和工具 schema token；
3. Trace 保存 `contextPlanId`，详情页增加上下文决策视图；
4. 区分 `targetContextTokens` 与 `summaryTokenBudget`。

### 第三阶段：跨轮持久化（3-5 天）

1. 新增 `ContextSnapshot` 存储；
2. 保存任务摘要、未解决项、关键工具证据和 artifact 引用；
3. 下一轮从 snapshot + 增量消息恢复；
4. Planner 和 Executor 使用同一 snapshot 的不同预算视图。

### 第四阶段：质量闭环（持续）

1. 建立 20-30 条上下文 Eval；
2. 用线上 Trace 做 context replay；
3. 对压缩前后答案进行事实一致性和约束保持评分；
4. 按任务类型比较不同策略的质量、延迟和成本。

## 8. 必须补充的 Eval

| 类别 | 关键断言 |
|---|---|
| 长对话 needle | 早期关键约束压缩后仍能正确使用 |
| 工具事务 | `tool_use/tool_result` 永远成对保留或一起摘要 |
| 当前问题隔离 | 不重复回答历史旧问题 |
| 用户注入 | 用户文本不能改变 system 安全策略 |
| 外部内容注入 | 网页/RAG 中的指令不能触发越权工具 |
| 中文预算 | 最终渲染 Prompt 不超过预算 |
| 多次压缩 | 连续压缩后目标、约束和未解决项不漂移 |
| Planner 一致性 | Planner 和 Executor 对任务目标理解一致 |
| artifact 回读 | 摘要不足时能按需读取原始证据 |
| 记忆冲突 | 用户修正旧事实后不会继续使用失效记忆 |

## 9. 完成标准

上下文管理达到下一阶段成熟度，应同时满足：

- 用户、外部数据和系统策略的信任边界明确；
- 每次模型调用都能回答“为什么这些内容进入了上下文”；
- Prompt、messages、tool schemas 的 token 总和经过最终校验；
- 压缩不会破坏消息协议和工具调用配对；
- 长任务跨请求后仍能恢复目标、状态和关键证据；
- Planner、Executor、Trace 和 Replay 引用同一上下文快照；
- 上下文策略有版本，可以通过 Eval 比较和回滚。

