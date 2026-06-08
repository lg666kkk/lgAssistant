# Agent Engineering Roadmap

本文档整理个人助手项目在三个方向上的成熟化规划：

1. 上下文工程：这一轮模型该看什么。
2. 记忆系统：长期该存什么、怎么召回、怎么治理。
3. Harness 工程：怎么测试、回放、观测、上线。

当前项目已经具备聊天 UI、Agent tool calling、RAG、Tavily `web_search`、Redis session history、Supabase longterm/semantic memory、trace/eval 雏形。下一阶段重点不是继续堆功能，而是补齐控制面：

- 上下文可解释。
- 记忆可信可控。
- 评测可回归。

## 总体目标

把当前系统从：

```text
Chat UI + Agent Loop + Tools + RAG + Memory 雏形
```

升级成：

```text
Context Orchestrator + Memory Service + Agent Runtime + Harness Platform
```

四条链路的职责如下：

- `Context Orchestrator`：负责每次请求带什么上下文进模型。
- `Memory Service`：负责记忆写入、召回、更新、遗忘和审计。
- `Agent Runtime`：负责 loop、tool calling、预算、停止条件和事件流。
- `Harness Platform`：负责 trace、eval、回放、回归和线上质量监控。

## 成熟 Agent 对标能力

成熟 Agent 通常不只是 “LLM + tools + history”，而是具备以下能力：

- 运行时编排：任务状态、工具路由、失败恢复、human-in-the-loop、暂停/恢复。
- 上下文工程：分层预算、检索策略、压缩、来源引用、防污染。
- 记忆系统：短期、长期、语义、情节、程序性记忆，并带写入门槛、去重、删除、审计。
- Harness 工程：trace、span、数据集、grader、回归测试、线上监控、成本/延迟/质量指标闭环。

## 一、上下文工程

### 目标

从简单的：

```text
messages + memorySystem + tools
```

升级为显式的 `ContextPlan`。每次模型调用前，都能知道：

- 系统提示是什么。
- 当前用户输入是什么。
- 保留了哪些会话历史。
- 注入了哪些长期记忆。
- 召回了哪些 RAG 文档。
- 使用了哪些 web 搜索结果。
- 工具结果占了多少 token。
- 哪些内容被压缩或丢弃。

### 建议模块

```text
lib/agent/context/types.ts
lib/agent/context/builder.ts
lib/agent/context/policy.ts
lib/agent/context/serializer.ts
lib/agent/context/compactor.ts
```

### 核心数据结构

```ts
type ContextItem = {
  id: string;
  type:
    | "system"
    | "user_input"
    | "session_message"
    | "memory"
    | "rag_doc"
    | "web_result"
    | "tool_result"
    | "summary";
  content: string;
  source: string;
  priority: number;
  estimatedTokens: number;
  relevanceScore?: number;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
};

type ContextPlan = {
  requestId: string;
  sessionId?: string;
  items: ContextItem[];
  totalEstimatedTokens: number;
  budget: ContextBudget;
  droppedItems: Array<{
    item: ContextItem;
    reason: string;
  }>;
  warnings: string[];
};
```

### API 边界

```ts
buildContextPlan(input): Promise<ContextPlan>
serializeForModel(plan): { system?: string; messages: ModelMessage[] }
compactContextPlan(plan, budget): ContextPlan
explainContextPlan(plan): ContextDebugInfo
```

### 分层预算建议

默认比例可以先按：

```text
system：10%
最近会话：25%
memory：15%
RAG / web：25%
tool result：15%
buffer：10%
```

上下文选择优先级：

1. 当前用户输入，永远 pinned。
2. 当前任务相关工具结果。
3. 高相关 RAG / semantic memory。
4. 最近 K 轮对话。
5. 长期偏好。
6. 老历史摘要。
7. 低相关召回内容丢弃。

### 阶段规划

#### P0：上下文装配显式化

- 把 `/api/chat` 中的历史拼接、memory 注入、上下文压缩抽到 Context Builder。
- trace 记录本轮使用了哪些 `ContextItem`。
- `search_notes`、`web_search`、memory 都带来源标签。
- `/api/chat` 变薄，只做请求校验、stream 和调用 orchestrator。

验收标准：

- 每轮请求能解释模型看到了什么。
- trace 中能看到 context plan。
- 长会话超过阈值后会触发可解释压缩。

#### P1：上下文预算策略产品化

- 每类上下文有独立预算。
- 不是简单截断字符串，而是按 item 丢弃、压缩、降采样。
- 工具结果支持结构化压缩。
- web 搜索结果只保留 title、url、snippet、top results。
- RAG 结果按相关性、来源、时间排序。

验收标准：

- trace 中能看到各类上下文占用 token 比例。
- 被丢弃内容有 `dropReason`。
- 工具结果不会挤爆会话历史。

#### P2：任务态工作记忆

成熟 Agent 不只依赖聊天历史，还需要结构化任务状态。

```ts
type WorkingState = {
  activeGoal?: string;
  constraints: string[];
  pendingQuestions: string[];
  completedSteps: string[];
  openToolResults: unknown[];
  userPreferencesInThisTask: string[];
};
```

用途：

- 长任务中不用每轮重新从 messages 猜现在做到哪。
- tool loop 停止后可以基于 state 总结。
- 后续支持 plan / execute / revise。

建议模块：

```text
lib/agent/runtime/state.ts
lib/agent/runtime/state-reducer.ts
```

## 二、记忆系统

### 目标

从“能召回、能沉淀”升级为“可信、可控、可演化”。

记忆不应该只是向量库里的文本，而应该有：

- 类型。
- 来源。
- 置信度。
- 生命周期。
- 冲突处理。
- 用户控制。

### 当前已有能力

```text
RedisSessionStore
LongTermStore
SemanticStore
recallForPrompt
consolidate
```

### MemoryRecord 升级方向

```ts
type MemoryRecord = {
  id: string;
  key: string;
  userId?: string;
  sessionId?: string;
  scopeId?: string;
  type:
    | "preference"
    | "fact"
    | "profile"
    | "project"
    | "procedure"
    | "correction"
    | "episodic";
  layer: "session" | "longterm" | "semantic";
  content: string;
  normalizedContent?: string;
  confidence: number;
  source: "user_explicit" | "inferred" | "tool" | "imported" | "system";
  evidence?: {
    requestId?: string;
    sessionId?: string;
    messageId?: string;
    excerpt?: string;
  };
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
  version: number;
  status: "active" | "archived" | "deleted" | "conflicted";
};
```

特别重要：

- `source` 区分用户明确表达和模型推断。
- `confidence` 决定是否注入上下文。
- `expiresAt` 防止临时偏好永久污染。
- `evidence` 保存来自哪次对话或 trace。

### 记忆写入管线

成熟 Agent 的记忆写入不应是 “LLM 抽取后直接 upsert”。

建议变成：

```text
conversation
→ extract candidates
→ classify type
→ normalize key
→ detect conflict
→ score importance
→ decide create/update/merge/ignore/ask_user
→ persist
→ emit memory event
```

建议新增模块：

```text
lib/agent/memory/extractor.ts
lib/agent/memory/classifier.ts
lib/agent/memory/consolidator.ts
lib/agent/memory/conflict.ts
lib/agent/memory/policy.ts
```

写入决策结构：

```ts
type MemoryWriteDecision = {
  action: "create" | "update" | "merge" | "ignore" | "ask_user";
  reason: string;
  confidence: number;
  candidate: MemoryCandidate;
  existingMemory?: MemoryRecord;
};
```

### 记忆原则

- 用户明确说的事实优先于模型推断。
- 当前输入优先于旧记忆。
- 低置信推断不写入。
- 冲突不静默覆盖。
- 一次性任务不写长期记忆。
- 外部网页、RAG 文档、工具结果不得直接写入长期记忆。
- 敏感信息默认不自动写入。

### 阶段规划

#### P0：统一 Memory Record 语义

- Supabase schema 增加 `type`、`source`、`confidence`、`status`、`evidence`。
- `consolidate` 输出结构化 memory candidates。
- 写入前做 validation。

验收标准：

- 所有记忆都有来源、类型、时间和置信度。
- trace 能看到记忆写入来源。
- 用户能问“你记得我什么”。

#### P1：记忆召回策略

当前 `recallForPrompt(query)` 主要按语义召回。后续应升级为 hybrid retrieval。

```ts
type MemoryRecallRequest = {
  query: string;
  userId?: string;
  sessionId?: string;
  taskType?: string;
  limit?: number;
  includeTypes?: string[];
  excludeExpired?: boolean;
};
```

召回策略：

1. 精确 key/profile 召回。
2. 语义召回。
3. 最近访问 boost。
4. 高置信 boost。
5. 过期和低置信降权。
6. 多样性去重。

验收标准：

- trace 中能看到每条记忆为什么被召回。
- 偏好类记忆召回准确率达到 80% 以上。
- 过期/低置信记忆不会轻易污染回答。

#### P2：记忆治理

用户可控能力：

- 查看全部记忆。
- 删除某条记忆。
- 暂停记忆。
- 指定“不要记住这件事”。
- 导出记忆。
- 合并重复记忆。

建议 API：

```text
GET /api/memory
POST /api/memory
PATCH /api/memory/:id
DELETE /api/memory/:id
POST /api/memory/forget
POST /api/memory/rebuild-embeddings
```

## 三、Harness / 评测 / 运维工程

### 目标

把 trace/eval 雏形升级成 Agent 工程的安全网：

- 每次改 prompt、tool、memory、context 策略，都知道有没有变好。
- 线上失败可以回放。
- 工具波动可以 mock。
- 成本和延迟可量化。

### Trace 标准化

当前已有：

```text
AgentTrace
TraceStep
formatTraceTree
saveTrace
agent_traces
```

建议增强：

```ts
type AgentTrace = {
  requestId: string;
  sessionId?: string;
  userId?: string;
  environment?: string;
  appVersion?: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  stopReason: string;
  completed: boolean;
  inputSummary?: string;
  outputSummary?: string;
  contextPlan?: ContextPlan;
  steps: TraceStep[];
  metrics: AgentLoopMetrics;
  error?: string;
};
```

Step 扩展：

```ts
type ModelStep = {
  model: string;
  systemHash?: string;
  contextTokens: number;
  outputTokens?: number;
  latencyMs: number;
  toolCalls: unknown[];
  finishReason?: string;
};

type ToolStep = {
  name: string;
  input: unknown;
  outputSummary: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  retryCount?: number;
  cost?: number;
};
```

内部事件建议：

```text
agent.request_started
context.plan_created
model.call_started
model.call_completed
tool.call_started
tool.call_completed
memory.recalled
memory.written
agent.request_completed
```

### Eval 用例体系

建议把 `lib/agent/eval/cases.ts` 从简单测试升级为可扩展数据集。

```ts
type EvalCase = {
  id: string;
  category: string;
  inputMessages: Array<{ role: "user" | "assistant"; content: string }>;
  sessionSeed?: unknown;
  memorySeed?: unknown;
  expectedTools?: string[];
  forbiddenTools?: string[];
  expectedMemoryWrites?: unknown[];
  expectedStopReason?: string;
  assertions: string[];
  tags: string[];
};
```

分类建议：

- `tool-routing`：是否调用正确工具。
- `web-search`：是否调用 `web_search`，是否避免过期知识。
- `rag`：是否调用 `search_notes`，sources 是否合理。
- `memory-recall`：是否使用已有记忆。
- `memory-write`：是否沉淀该记的事实。
- `context-budget`：长历史下是否保留关键内容。
- `abort`：用户停止后是否不重试。
- `tool-failure`：工具失败、空结果、超时。
- `safety`：隐私、prompt injection、危险工具。
- `regression`：曾经出过 bug 的 case。

断言层级：

1. 确定性断言：工具名、调用次数、stopReason、是否写记忆。
2. 结构断言：trace step 顺序、context item 是否存在。
3. LLM-as-judge：回答质量、引用是否充分，放到非 CI。

### Replay Harness

成熟 Agent 必须能回答：

```text
这次线上失败，如果用新版本策略跑，会不会好？
```

新增能力：

```text
trace → replay input → mock tool results → run new config → compare traces
```

建议模块：

```text
lib/agent/harness/replay.ts
lib/agent/harness/diff.ts
lib/agent/harness/report.ts
```

对比维度：

- 是否调用不同工具。
- token 是否下降。
- latency 是否上升。
- memory 是否多写/漏写。
- 最终回答是否改变。
- stopReason 是否改善。

### 线上指标

核心指标：

- 请求成功率。
- 平均 latency / p95 latency。
- model call 次数。
- tool call 次数。
- tool error rate。
- repeated tool call rate。
- token budget exceeded rate。
- memory recall hit rate。
- memory write rate。
- user abort rate。
- RAG no-result rate。
- `web_search` 使用率。
- eval pass rate 趋势。

告警建议：

- tool error rate 连续升高。
- token budget exceeded 突增。
- memory write rate 异常升高。
- RAG no-result rate 突增。
- p95 latency 超阈值。

建议模块：

```text
lib/agent/ops/metrics.ts
lib/agent/ops/health.ts
app/api/health/route.ts
app/api/admin/traces/route.ts
```

## 推荐实施路线

### 里程碑 1：先让系统看得见

周期：1-2 周。

- 抽出 `ContextPlan`。
- trace 记录 context plan。
- `web_search` 结果接入 sources。
- eval 增加 `web-search`、`tool-routing`、`context-budget`。
- `/api/chat` 变薄，只做请求校验、stream、调用 orchestrator。

### 里程碑 2：让记忆可信

周期：2-3 周。

- Memory schema 增加 `type/source/confidence/status/evidence`。
- `consolidate` 改为 candidate → decision → write。
- 支持 memory conflict 和 ignore。
- 增加 `memory-write` 和 `memory-recall` eval。

### 里程碑 3：让改动可回归

周期：2-4 周。

- 通用 agent harness。
- mock Tavily/RAG/Redis/Supabase。
- trace replay。
- eval report。
- live/mock 双轨固化到 npm scripts。
- tool result cache。

### 里程碑 4：进入成熟运维

持续迭代。

- 记忆管理 API/UI。
- ops dashboard。
- prompt/model/tool/memory policy 版本化。
- A/B 测试。
- 失败样本自动进入 eval 候选。
- 隐私与日志脱敏。

## 最优先做的 7 件事

1. 建立 `ContextPlan`，统一管理本轮上下文。
2. 把 `ContextPlan` 写入 trace，先可观测。
3. 把 `web_search` 的搜索结果接入前端 sources 展示。
4. 升级 Memory schema：`type/source/confidence/evidence/status`。
5. 建立 `MemoryWriteDecision`，禁止直接抽取后 upsert。
6. 扩展 eval cases：web、memory、context、abort。
7. 建立 tool mock + replay，让测试不依赖 Tavily/模型波动。

## 风险清单

1. 上下文黑箱：模型到底看到了什么不可解释，会导致所有质量问题难排查。
2. 错误记忆污染：一条错记忆会反复影响后续回答，比单次错误更危险。
3. Eval 太弱：只测工具调用，不测 memory/context，后面重构会悄悄退化。
4. `/api/chat` 过胖：继续堆逻辑会变成所有能力耦合点。
5. 外部工具不稳定：web/RAG/embedding/model 任一失败都要在 trace 和 fallback 中可见。
6. `sessionId` 不是 `userId`：长期记忆最终必须有真正用户作用域，否则会有隔离风险。

## 当前推荐判断

下一阶段最优先做的不是继续加新工具，而是把三个控制面立起来：

```text
ContextPlan + MemoryWriteDecision + Trace/Eval
```

这三个能力一旦成型，后续加 planner、多 Agent、浏览器操作、文件操作、复杂任务编排都会稳很多。
