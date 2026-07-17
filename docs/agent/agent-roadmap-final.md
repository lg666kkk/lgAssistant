# Agent 成熟化路线图（最终整合版）

> ⚠️ **2026-07 更新**：本文部分条目已落地（C1 语义压缩、C4 Prompt Pipe、H4 工具并发、Planning 已实现为 Plan-and-Execute + 审批等）。
> 最新路线图见 [enterprise-agent-roadmap.md](./enterprise-agent-roadmap.md)，其第 0 节含逐条现状校准；本文保留作为对标分析的原始依据。

> 本文是两份前置文档的整合最终版，**原文保留以便追溯**：
> - [maturity-benchmark-roadmap.md](./maturity-benchmark-roadmap.md) —— 对标差距分析（对标表 + 真实行号 + 成本/面试杀伤力评分 + 面试话术）
> - [agent-engineering-roadmap.md](./agent-engineering-roadmap.md) —— 架构蓝图（目标架构 + 类型设计 + 模块树 + 里程碑/Ops/风险）
>
> **整合采用双主线**：
> - **上半部「看差距」** —— 对标成熟产品（mem0 / Zep / Generative Agents / Claude Code / Anthropic / LangSmith），逐项给出当前缺口（锚定真实代码行号）、成本（S/M/L）、面试杀伤力（高/中/低）、面试话术。
> - **下半部「看怎么建」** —— 目标架构、核心类型设计、新增模块树、里程碑周期、线上 Ops 指标、风险清单。
>
> 调研方式：多 Agent 并行对标 + lead 基于代码实锤补齐。所有「本项目现状」均为代码事实。

---

## 0. 总览

### 现在处在哪

| 方向 | 已做（优势） | 性质判断 |
|---|---|---|
| 上下文 | TokenBudget + 工具结果截断 + 滚动压缩骨架 | 框架对，但 **compaction 是暴力截断（隐藏 bug）+ 零 prompt caching + 上下文黑箱** |
| 记忆 | 三层架构（session/longterm/semantic）+ LLM 抽取 + 向量召回 | 有存储，**缺生命周期管理层**——正是 mem0/Zep/Letta 的核心卖点 |
| Harness | Trace 落库 + Eval 双轨 + 结构化事件协议 | **trace 基建已领先多数面试项目**，缺 LLM-as-judge / 错误恢复 / 并发 / Replay |

### 目标架构（一句话）

把当前的 `Chat UI + Agent Loop + Tools + RAG + Memory 雏形` 升级成四条职责清晰的控制面：

```text
Context Orchestrator  ——  每次请求带什么上下文进模型（可解释）
Memory Service        ——  记忆写入/召回/更新/遗忘/审计（可信可控）
Agent Runtime         ——  loop/tool calling/预算/停止条件/事件流/错误恢复
Harness Platform      ——  trace/eval/replay/回归/线上质量监控（可回归）
```

> 核心判断：下一阶段最优先的不是加新工具，而是立起三个控制面 **ContextPlan + MemoryWriteDecision + Trace/Eval**。这三样成型后，加 planner、多 Agent、文件/浏览器操作都会稳很多。

### 评分口径

实现成本 S（半天）/ M（1-2 天）/ L（3 天+）；面试杀伤力 高/中/低。

---

# 上半部：看差距（对标 + 评分 + 面试话术）

## 一、上下文工程 —— 对标差距

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| 压缩 | [compaction.ts:32-36](../../lib/agent/runtime/compaction.ts) | 超阈值时保留首条+最近 4 条，中间消息 `JSON.stringify().slice(0,300)` **暴力截断** |
| token 计量 | [budget.ts:57](../../lib/agent/runtime/budget.ts) | `char/4` 粗估，中文误差大 |
| 真实 usage | [runtime/index.ts:366](../../lib/agent/runtime/index.ts) | trace 里**已记录真实 `input_tokens`**，但 budget 没用它校准 |
| prompt 组装 | [runtime/index.ts:125](../../lib/agent/runtime/index.ts) | system 字符串直接拼接，每轮整段重传 |
| prompt caching | 无 | **`cache_control` 零命中**，system+工具定义每轮整段重传 |
| 可解释性 | 无 | 无法回答「这一轮模型到底看到了什么」 |

### 对标表

| 维度 | 成熟做法 | 本项目现状 | 差距 |
|---|---|---|---|
| 压缩策略 | Claude Code auto-compact：调 LLM 把早期轮次摘要成连贯段落 | 暴力截断半句话 | **大（实为 bug）** |
| token 计量 | 真实 tokenizer / 模型返回 usage | char/4 估算，未用已有真实值 | 中 |
| prompt 组装 | 分层（身份/记忆/RAG/工具说明），各部分预算独立 | 字符串硬拼 | 中 |
| 缓存利用 | Prompt Caching 给稳定前缀打 `cache_control` | 零缓存，每轮重传 | **大** |
| 可解释性 | ContextPlan 显式记录每个 item 的来源/token/丢弃原因 | 上下文黑箱 | **大** |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **C1** | **compaction 改 LLM 摘要式** | Claude Code auto-compact | `compaction.ts:32` 暴力截断，**喂半句话给模型（隐藏 bug）** | M | **高** |
| **C2** | **Prompt Caching（cache_control）** | Anthropic Prompt Caching | 零命中，system+工具定义每轮整段重传 | **S** | **高** |
| **C5** | **ContextPlan 显式装配 + 写入 trace** | Anthropic context eng / 架构蓝图 | 上下文黑箱，无法解释模型看到了什么 | M | **高** |
| C3 | token 计量用真实 usage 校准 | — | `budget.ts:57` char/4，`index.ts:366` 已有真实值没用 | S | 中 |
| C4 | Prompt 分层组装管道 | Anthropic context eng | system 字符串硬拼 | M | 中 |

**面试话术要点**：
- **C1**：「暴力截断破坏语义连续性，模型看到半句话反而被误导；LLM 摘要式压缩在成本和保真之间取平衡。」
- **C2**：「多轮 loop 里 system 和工具定义是稳定前缀，用 prompt caching 给它打缓存，缓存命中部分约 1/10 价格 + 更低延迟。」
- **C5**：「上下文黑箱是一切质量问题难排查的根源。我用 ContextPlan 把每轮注入的每个 item（来源/token/相关性/是否被丢弃）显式化并写进 trace，让『模型看到了什么』变得可解释。」

---

## 二、记忆系统 —— 对标差距

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| 抽取 | [memory-flow.ts:63-114](../../lib/agent/memory/memory-flow.ts) `consolidate()` | LLM 自由生成 `fact`+`key` |
| 写入 | [memory-flow.ts:98-103](../../lib/agent/memory/memory-flow.ts) | 双写，`onConflict:"key"` upsert |
| 冲突处理 | [semantic-store.ts:48-51](../../lib/agent/memory/semantic-store.ts) | **仅 SQL key 相同则覆盖**，无语义级 ADD/UPDATE/DELETE |
| 召回 | [memory-flow.ts:28-38](../../lib/agent/memory/memory-flow.ts) | 固定 limit=5、阈值 0.3，全注入，无重排 |
| Schema | [types.ts:3-11](../../lib/agent/memory/types.ts) | **无 type/importance/confidence/source/status/last_accessed** |
| 遗忘 | 无 | 仅手动 forget，无衰减/TTL |
| 用户可控 | 无 | 无查看/编辑/溯源 |

### 对标表（六维 × 五产品）

| 维度 | mem0 | Letta/MemGPT | ChatGPT/Claude | Generative Agents | Zep/Graphiti | 本项目 |
|---|---|---|---|---|---|---|
| 抽取 | 两阶段，msg pair+summary | Agent 自调 append/replace | 周期性 synthesis | LLM 给 importance 打分 | 抽 fact+时间 | 抽 fact+key |
| 冲突更新 | **ADD/UPDATE/DELETE/NOOP**，先召回相似再决策 | 自编辑 replace | 自动解决矛盾 | 无（纯追加） | **bi-temporal 软失效** | **仅 key 覆盖** |
| 检索策略 | top-k 向量 | core 常驻 | synthesis 常注入 | **三因子 recency·γ^Δt+importance+relevance** | semantic+keyword+graph | 固定 top-5 无重排 |
| 记忆类型 | episodic/semantic/偏好 | core/recall/archival | saved vs history | observation/reflection | entity/fact/episode | 仅 layer |
| 遗忘机制 | UPDATE/DELETE | paging 换入换出 | 容量淘汰/reset | **recency 指数衰减** | 软失效不删 | 无 |
| 用户可控 | API 增删查 | Agent 自管 | **可视化+可编辑+溯源** | N/A | 全程 provenance | 无 |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **M1** | **ADD/UPDATE/DELETE/NOOP 冲突决策**（MemoryWriteDecision） | mem0 | `memory-flow.ts:98` 自拟 key upsert，事实演化新旧并存 | M | **高** |
| **M2** | **valid/invalid 软失效（替代硬删）** | Zep bi-temporal | DELETE 真删丢历史 | M | **高** |
| **M3** | **召回：多召→重排→截断（三因子）** | Generative Agents | `memory-flow.ts:32` 固定 top-5、无重排 | M | **高** |
| M4 | schema 加 type/source/confidence/status/importance/last_accessed/evidence | GA + mem0 + 架构蓝图 | `types.ts` 无这些字段，M1/M3 无数据可用 | M | 中 |
| M5 | 抽取传完整 transcript | mem0 | `route.ts:163` 只传本轮 user 消息（已核实） | **S** | 中 |
| M6 | 记忆治理：可视化+编辑+溯源+「别记这件事」 | ChatGPT/Claude | 无查看/编辑出口 | L | 中 |

**改法要点**：
- **M1**：`consolidate()` 抽取后、写入前插 update 阶段——每条 fact 先 `semantic.recall(fact,5)` 拿相似旧记忆，把「新 fact + 候选旧记忆（带 id）」喂决策 prompt 返回 `MemoryWriteDecision`，按四操作分支执行。
- **M2**：DELETE 改 `update(key,{valid_to:now})`；召回默认只查 `valid_to is null`。
- **M3**：recall 放宽到 20-30；按 `score = w_r·relevance + w_i·importance + w_t·recency` 重排取 top-k；重排出错 fail-open 回退余弦序。
- **M5**：`route.ts:163` 改传 `agentLoopResult.loopMessages`，`memory-flow` 这侧零改动。

**面试话术**：「初版 LLM 自拟 key 做 upsert，事实演化时新旧并存。对标 mem0，把抽取和更新拆开，更新阶段先召回相似旧记忆让 LLM 在 create/update/merge/ignore 间决策，把冲突交给模型当 controller 而非脆弱 if/else；删除对标 Zep 改软失效，保留『某时刻为真』的可追溯性。」

**记忆原则（写入门槛）**：用户明确说的 > 模型推断；当前输入 > 旧记忆；低置信推断不写；冲突不静默覆盖；一次性任务不写长期；外部网页/RAG/工具结果不直接写长期；敏感信息默认不自动写。

---

## 三、Harness 工程 —— 对标差距

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| Agent Loop | [runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop` | 反应式多轮，maxToolIterations=8 |
| Trace | [trace.ts](../../lib/agent/runtime/trace.ts) + [trace-store.ts](../../lib/agent/runtime/trace-store.ts) | AgentTrace 落库 Supabase |
| Eval | [eval/cases.ts](../../lib/agent/eval/cases.ts) | **仅 3 条，断言全结构化**，无 LLM-as-judge |
| 错误处理 | [runtime/index.ts:202](../../lib/agent/runtime/index.ts) | 工具失败直接回灌，无重试/无瞬时 vs 永久区分 |
| 重复检测 | [runtime/index.ts:386](../../lib/agent/runtime/index.ts) | 命中即终止整 loop，可能误杀 |
| 工具执行 | [runtime/index.ts:151](../../lib/agent/runtime/index.ts) | 串行 `await` |
| Replay | 无 | 无法回放线上失败、对比新旧策略 |

### 对标表

| 维度 | 成熟做法 | 本项目现状 | 差距 |
|---|---|---|---|
| 可观测 trace | LangSmith/LangFuse 结构化调用树 | 已有 trace.ts/trace-store.ts | **小（优势）** |
| 评测 eval | LLM-as-judge + 回归数据集 | 仅 3 条全结构化断言 | **大（最大缺口）** |
| 错误恢复 | transient/permanent 分类 + 退避重试 + 降级 | 失败直接回灌 | 中 |
| 重复检测 | stuck 阈值化，同工具不同参放行（OpenHands） | 命中即终止 | 中 |
| Replay | trace→replay→mock tool→对比新旧 trace | 无 | 中 |
| 规划 | 长程任务才上 plan（Anthropic） | 纯反应式 | 小~无 |
| 并发 | Promise.all 并行无依赖工具 | 串行 await | 中 |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **H1** | **LLM-as-judge eval + 用例扩展（web/memory/context/abort/safety）** | LangSmith/Braintrust | `eval/cases.ts` 仅 3 条全结构化 | M | **高** |
| **H2** | **工具错误恢复（transient/permanent + 重试 + 降级）** | OpenAI guardrail/OpenHands | `index.ts:202` 失败直接回灌 | S~M | **高** |
| **H5** | **Replay Harness（trace→mock→对比）** | LangSmith / 架构蓝图 | 无法回放线上失败 | L | 中 |
| H3 | 重复检测→stuck 阈值化 | OpenHands | `index.ts:386` 命中即终止 | S | 中 |
| H4 | 工具并发 Promise.all | — | `index.ts:151` 串行 await | S | 中 |
| ❌ | ~~Planning / 子任务分解~~ | — | 纯反应式 | — | **建议不做** |

**关键洞察**：
- **H1** 复用已有 trace 基建——judge 直接吃 `trace.steps` 结构化对象打分（不用 parse 日志），judge model + rubric 钉进 git 与被测模型解耦，RAG case 用 `toolSources` 做 faithfulness 校验。**断言分三层**：① 确定性（工具名/次数/stopReason/是否写记忆）② 结构（trace step 顺序/context item 是否存在）③ LLM-as-judge（回答质量，放非 CI）。
- **❌ Planning 刻意不做**：3-4 步任务上 planning 是负优化（Anthropic「能不上 agent 就不上」）。「为什么不上 planning、坚持 ReAct 甜区」是面试加分论点。

---

# 下半部：看怎么建（架构蓝图 + 类型 + 模块 + Ops）

## 四、Context Orchestrator —— 目标架构

把 `messages + memorySystem + tools` 升级为显式 `ContextPlan`，每轮可解释。

### 核心类型

```ts
type ContextItem = {
  id: string;
  type: "system" | "user_input" | "session_message" | "memory"
      | "rag_doc" | "web_result" | "tool_result" | "summary";
  content: string;
  source: string;
  priority: number;
  estimatedTokens: number;
  relevanceScore?: number;
  pinned?: boolean;
};

type ContextPlan = {
  requestId: string;
  sessionId?: string;
  items: ContextItem[];
  totalEstimatedTokens: number;
  droppedItems: Array<{ item: ContextItem; reason: string }>;
  warnings: string[];
};
```

### 新增模块

```text
lib/agent/context/{types,builder,policy,serializer,compactor}.ts
```

### 分层预算（默认比例）+ 选择优先级

```text
预算：system 10% / 最近会话 25% / memory 15% / RAG·web 25% / tool result 15% / buffer 10%
优先级：当前输入(pinned) > 当前任务工具结果 > 高相关 RAG·记忆 > 最近 K 轮 > 长期偏好 > 老历史摘要 > 低相关丢弃
```

> 对应上半部 C1（compactor 用 LLM 摘要）、C3（estimatedTokens 用真实 usage 校准）、C5（builder 产出 ContextPlan 写入 trace）。

### 任务态工作记忆（进阶，P2）

```ts
type WorkingState = {
  activeGoal?: string; constraints: string[]; pendingQuestions: string[];
  completedSteps: string[]; openToolResults: unknown[];
};
```
模块：`lib/agent/runtime/{state,state-reducer}.ts`。长任务中不用每轮从 messages 猜进度。

---

## 五、Memory Service —— 目标架构

### MemoryRecord 升级（对应上半部 M1/M2/M4）

```ts
type MemoryRecord = {
  id: string; key: string; userId?: string; sessionId?: string;
  type: "preference" | "fact" | "profile" | "project" | "procedure" | "correction" | "episodic";
  layer: "session" | "longterm" | "semantic";
  content: string; normalizedContent?: string;
  confidence: number;
  source: "user_explicit" | "inferred" | "tool" | "imported" | "system";
  evidence?: { requestId?: string; sessionId?: string; excerpt?: string };
  createdAt: string; updatedAt: string; lastAccessedAt?: string; expiresAt?: string;
  version: number;
  status: "active" | "archived" | "deleted" | "conflicted";
};
```
关键：`source` 区分明确 vs 推断；`confidence` 决定是否注入；`expiresAt` 防临时偏好永久污染；`evidence` 保来源。

### 记忆写入管线（取代「抽取后直接 upsert」）

```text
conversation → extract candidates → classify type → normalize key
→ detect conflict → score importance → decide(create/update/merge/ignore/ask_user)
→ persist → emit memory event
```
模块：`lib/agent/memory/{extractor,classifier,consolidator,conflict,policy}.ts`

```ts
type MemoryWriteDecision = {
  action: "create" | "update" | "merge" | "ignore" | "ask_user";
  reason: string; confidence: number;
  candidate: MemoryCandidate; existingMemory?: MemoryRecord;
};
```

### 记忆治理 API（对应上半部 M6）

```text
GET /api/memory · POST /api/memory · PATCH /api/memory/:id
DELETE /api/memory/:id · POST /api/memory/forget · POST /api/memory/rebuild-embeddings
```

---

## 六、Harness Platform —— 目标架构

### Trace 增强（已有 AgentTrace 基础上加）

```ts
// AgentTrace 增补：userId / environment / appVersion / model / contextPlan / inputSummary / outputSummary
// ModelStep 增补：systemHash / contextTokens / finishReason
// ToolStep 增补：retryCount / cost
```

内部事件：`agent.request_started / context.plan_created / model.call_* / tool.call_* / memory.recalled / memory.written / agent.request_completed`

### Eval 用例体系（对应上半部 H1）

```ts
type EvalCase = {
  id: string; category: string;
  inputMessages: Array<{ role: "user" | "assistant"; content: string }>;
  sessionSeed?: unknown; memorySeed?: unknown;
  expectedTools?: string[]; forbiddenTools?: string[];
  expectedMemoryWrites?: unknown[]; expectedStopReason?: string;
  assertions: string[]; tags: string[];
};
```
分类：`tool-routing / web-search / rag / memory-recall / memory-write / context-budget / abort / tool-failure / safety / regression`

### Replay Harness（对应上半部 H5）

```text
trace → replay input → mock tool results → run new config → compare traces
```
模块：`lib/agent/harness/{replay,diff,report}.ts`。对比：工具是否不同 / token 升降 / latency / 记忆多写漏写 / 回答是否改变。

### 线上指标 + 告警

```text
指标：成功率 / p95 latency / tool error rate / repeated tool call rate
     / token budget exceeded rate / memory recall hit rate / RAG no-result rate / eval pass rate 趋势
告警：tool error rate 连升 / budget exceeded 突增 / memory write rate 异常 / p95 超阈值
```
模块：`lib/agent/ops/{metrics,health}.ts` · `app/api/{health,admin/traces}/route.ts`

---

## 七、推荐实施路线（里程碑）

| 里程碑 | 周期 | 内容 | 对应改进项 |
|---|---|---|---|
| **M1 先让系统看得见** | 1-2 周 | 抽出 ContextPlan 写入 trace；web_search 接入 sources；`/api/chat` 变薄；eval 加 web/tool-routing/context-budget | C5 · C2 · H1 |
| **M2 让记忆可信** | 2-3 周 | Memory schema 加 type/source/confidence/status/evidence；consolidate 改 candidate→decision→write；支持 conflict/软失效；加 memory eval | M1 · M2 · M4 · M5 |
| **M3 让改动可回归** | 2-4 周 | 通用 harness；mock Tavily/RAG/Redis/Supabase；trace replay；eval report；LLM-as-judge；tool result cache | H1 · H2 · H5 |
| **M4 进入成熟运维** | 持续 | 记忆管理 API/UI；ops dashboard；policy 版本化；A/B；失败样本自动进 eval；日志脱敏 | M6 · Ops |

### 跨方向「先做这几件」（按面试性价比）

**第一梯队（高杀伤力，优先做）：**
1. **C2 Prompt Caching**（S/高）— 改动最小、立竿见影
2. **C1 LLM 摘要式 compaction**（M/高）— 修隐藏 bug
3. **M1+M2 记忆冲突决策 + 软失效**（M+M/高）— 记忆系统最经典面试题
4. **H1 LLM-as-judge**（M/高）— 让「可度量」从口号变 demo
5. **C5 ContextPlan + 写入 trace**（M/高）— 破上下文黑箱

**第二梯队：** M3+M4 三因子检索 · H2 错误恢复 · M5（顺手 S）· C3 真实 usage 校准 · H5 Replay

**口头讲（不必实现）：** M6 记忆可视化 · ❌ 为什么不上 Planning

---

## 八、风险清单

1. **上下文黑箱**：模型看到什么不可解释 → 所有质量问题难排查（→ C5）。
2. **错误记忆污染**：一条错记忆反复影响后续回答，比单次错误更危险（→ M1/M2 写入门槛+软失效）。
3. **Eval 太弱**：只测工具调用不测 memory/context → 重构会悄悄退化（→ H1）。
4. **`/api/chat` 过胖**：继续堆逻辑会变成所有能力的耦合点（→ C5 抽 orchestrator）。
5. **外部工具不稳定**：web/RAG/embedding/model 任一失败要在 trace 和 fallback 中可见（→ H2）。
6. **`sessionId` ≠ `userId`**：长期记忆最终必须有真正用户作用域，否则有隔离风险（→ M4 加 userId）。

---

## 延伸阅读（对标来源）

- **mem0**：[Overall Architecture](https://medium.com/@zeng.m.c22381/mem0-overall-architecture-and-principles-8edab6bc6dc4) · [Dwarves breakdown](https://memo.d.foundation/breakdown/mem0)
- **Letta/MemGPT**：[Letta Docs](https://docs.letta.com/concepts/memory-management/) · [vectorize 对比](https://vectorize.io/articles/mem0-vs-letta)
- **Generative Agents**：[arXiv 2304.03442](https://arxiv.org/pdf/2304.03442)（三因子检索）
- **Zep/Graphiti**：[arXiv 2501.13956](https://arxiv.org/abs/2501.13956) · [getzep/graphiti](https://github.com/getzep/graphiti)（bi-temporal 软失效）
- **ChatGPT/Claude Memory**：[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) · [Claude 记忆](https://support.claude.com/en/articles/11817273)
- **Anthropic**：Building effective agents · Effective context engineering for AI agents · Prompt Caching 文档
- **Eval 工业做法**：LangSmith / LangFuse / Braintrust（LLM-as-judge + 回归数据集）
- 本项目已有：[agent-loop-interview-summary.md](./agent-loop-interview-summary.md) · [agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md)
