# Agent 可观测性现状评估与完善方案

> 评估日期：2026-07-16（同日整合代码审查执行清单，原 observability-quick-wins.md 已并入本文）  
> 评估依据：当前仓库 Trace、Langfuse/OTel、SSE、Usage、RAG 观测和 Eval 实现。  
> 上下文专题参考：[Agent 上下文管理面试题库](../../interview/context-management-interview-questions.md)
> 整合新增：关键缺口的 file:line 锚点、P1-5 降级路径上报、§9.0 快速落地批次（映射企业路线图 E9/E11）、§12 面试视角。

## 1. 结论

项目已经有可用于开发调试的 Agent 可观测性，但还没有形成可用于生产运营的统一观测系统。

当前不是“没有 Trace”，而是存在两套覆盖范围不同的观测链路：

1. **本地 AgentTrace**：理解 Agent 语义，能展示 model/tool/plan/compaction；
2. **Langfuse + OpenTelemetry**：覆盖 AI SDK 模型调用和部分 API 根 observation。

两者没有统一的 run/span 标识、生命周期和持久化保证，因此同一次请求可能出现：Langfuse 有记录但本地没有、本地只记录 Agent Loop 而缺少 Planner/最终回答、异常只留在控制台等情况。

成熟度判断：

| 维度 | 评分 | 判断 |
|---|---:|---|
| 单次请求调试 | 3.5/5 | 已能看模型、工具、上下文和 RAG 细节 |
| Trace 完整性 | 2.5/5 | 多个前置、后置和失败阶段未进入本地 Trace |
| 跨系统关联 | 2/5 | 主要依靠 requestId，没有本地与 OTel/Langfuse 的稳定映射 |
| Metrics/SLO/告警 | 1.5/5 | 有请求级 metrics，没有服务级时序指标和告警 |
| Eval/Replay/发布门禁 | 1.5/5 | Eval 规模很小，没有 Replay 和版本对比 |
| 数据治理 | 1.5/5 | Trace 含用户和工具内容，缺统一脱敏、保留期和采样策略 |

综合为 **3/5 的开发可观测性、约 1.5-2/5 的生产可观测性**。

## 2. 当前观测架构

```text
POST /api/chat
  |
  +-> Langfuse root observation: agent-chat
  |     \-> AI SDK experimental_telemetry model spans
  |
  +-> runAgentLoop / executePlan
  |     \-> AgentTrace: model / tool / plan / context_compaction
  |
  +-> SSE events
  |     \-> model_usage / context_usage / plan_progress / errors
  |
  +-> Supabase agent_traces
  |     \-> /traces 列表、详情和 RAG 代理指标
  |
  \-> /usage
        \-> 扫描 trace JSONB，聚合 token、cache 和费用
```

已有基础：

- `lib/agent/runtime/trace.ts` 定义领域 Trace 语义；
- `lib/agent/runtime/trace-store.ts` 将完整 Trace 保存到 Supabase；
- `instrumentation.ts` 注册 `LangfuseSpanProcessor`；
- `lib/agent/runtime/model-provider.ts` 为 AI SDK 模型调用开启 telemetry；
- `/traces` 支持按会话查看运行结果；
- Trace 详情能展示 system segments、模型 usage、工具输入输出、压缩和 RAG debug；
- `/usage` 能按 Trace 还原模型 token、cache 命中和费用；
- Eval 已具备 mock/live 的基本运行骨架。

## 3. 当前覆盖矩阵

| 阶段 | 本地 AgentTrace | Langfuse/OTel | 当前问题 |
|---|---|---|---|
| 鉴权/请求解析 | 无 | 根 observation 部分覆盖 | 无统一阶段耗时和错误分类 |
| 会话历史恢复 | 无 | 无 | 失败只写 console |
| 知识库画像构建 | 无 | 内部 LLM 可能有 span | 无法从主 run 判断是否降级 |
| 长期记忆召回 | 只看到最终记忆段 | 无 | 无候选、分数、耗时和失败事件 |
| Prompt Pipe | 只看到保留段 | 无 | omitted/truncated 决策丢失 |
| Planner | 无本地 Trace | 有独立 observation | 本地 Trace 页面看不到计划生成/修复 |
| Agent 模型调用 | 有 | 有 | 两套记录缺少稳定 span 映射 |
| 工具执行 | 有 | 无正式 tool span | Langfuse 时间线缺工具内部耗时和错误 |
| 上下文压缩 | 执行时有 | 压缩模型有 span | 跳过原因只写 console |
| 最终总结流 | 无本地 model step | 有模型 telemetry | 本地 Trace 提前保存，结果不完整 |
| 记忆沉淀 | 无 | 无 | 失败只写 console |
| 会话/Trace 持久化 | 无 | 无 | 失败无重试、无指标 |
| 请求异常/中止 | 通常无完整 Trace | 根 observation 有 | 本地 stop reason 语义不完整 |

## 4. 关键缺口

### P0-1 本地 Trace 不是请求级完整生命周期

`AgentTrace` 在 `runAgentLoop` 或 `executePlan` 内创建，因此没有覆盖历史恢复、记忆召回、Prompt 组装和 Planner。Agent Loop 返回后立即异步保存 Trace；如果后续还要执行最终总结流，这次模型调用不会进入已保存的本地 Trace。

计划提案、规划失败、路由异常和部分 abort 路径也会在保存本地 Trace 之前返回。

建议：

- 在 API 请求边界创建 `AgentRunTrace`；
- 所有阶段都向同一 run 添加 span/event；
- 请求开始先写入 `running` 记录；
- 在统一 `finally` 中写 terminal status；
- Planner、Agent Loop 和最终总结成为同一 run 的子 span。

### P0-2 stop reason 无法准确表达中止和异常

当前 `AgentLoopStopReason` 没有 `aborted`、`error`、`provider_error`、`tool_error` 等终止原因；`shouldStop()` 命中时返回 `completed=false`、`stopReason="completed"`，会污染完成率和失败分析。

建议把状态和原因分开：

```text
status: running | waiting | succeeded | failed | cancelled
terminalReason:
  end_turn | awaiting_user | max_tokens | budget_exceeded
  | max_iterations | repeated_tool_call | user_cancelled
  | provider_error | tool_error | persistence_error | internal_error
```

错误同时记录 `stage/errorClass/retryable/errorCode`，避免只保存错误字符串。

### P0-3 Trace 持久化是 best-effort

`saveTrace`（`trace-store.ts:4`）通过 `void ...catch` 异步调用，落库失败只打印日志。进程结束、请求结束或 Supabase 短暂失败时，Trace 可能永久丢失，而且没有 trace-write-failure 指标。**进程崩溃/超时/用户中断的极端路径下 trace 整个丢失——最需要 trace 的场景最没有 trace。**

建议分三步演进：

0. 最小解（S 级，当天可做）：abort/error 路径也落一次标 `partial: true` 的部分 trace；
1. 当前架构下至少等待最终 upsert 完成，并设置短超时；
2. worker 化后使用事件/outbox，异步批量写 Trace，失败可重试并进入 DLQ。

验收指标：已接受 run 中，具有 terminal trace 的比例不低于 99.9%。

### P0-4 本地 Trace 与 Langfuse 没有统一关联

本地主要使用 `requestId/sessionId`，但没有保存 OTel `traceId/spanId`、Langfuse trace URL 或 observation id。排障时无法从本地页面一键跳转到同一次 Langfuse 调用，也无法自动核对两边是否缺数据。

建议确定 canonical `runId`：

- 生成一次，贯穿 API、Planner、模型、工具、RAG、记忆和后台任务；
- 写入 OTel attributes、Langfuse metadata、本地 Trace 和结构化日志；
- 本地保存 `otelTraceId/rootSpanId`；
- Plan 子步骤使用 `parentSpanId`，不再用修改 requestId 的方式表达层级。

最小解可先行（S 级）：`agent_traces` 先加一列存 Langfuse trace id（在 `route.ts:265` 的 root observation 处取），/traces 详情页加外链按钮；反向在 Langfuse metadata 带 `/traces/{requestId}` 链接。排障体验立刻差一个数量级。

### P1-1 Trace 是平铺步骤，不是真正的 span 树

`TraceStep` 只有 `index/startedAt/durationMs`，没有 `spanId/parentSpanId/endedAt/status`。Plan 下的 model/tool 被重新编号后平铺；并行工具也无法在 UI 中正确表现重叠关系。

另外，工具步骤的 `startedAt` 在工具已经执行结束后才赋值，虽然 `durationMs` 基本可用，但开始时间不准确。

建议统一 span 基类：

```ts
type AgentSpan = {
  spanId: string;
  parentSpanId?: string;
  kind: "request" | "context" | "planner" | "model" | "tool"
      | "rag" | "memory" | "approval" | "persistence";
  name: string;
  status: "running" | "ok" | "error" | "cancelled";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  error?: StructuredError;
};
```

### P1-2 缺少行为版本，线上结果不可复现

Trace 没有记录：

- app commit/build version；
- Prompt 版本；
- ContextPolicy 版本；
- toolset/schema hash；
- model provider/config version；
- RAG pipeline/version；
- memory policy version。

当质量突然变化时，只能看到模型名，无法判断是 Prompt、工具描述、检索策略还是代码发布造成。

建议增加不可变 `ReleaseDescriptor`，每条 run 都保存完整版本集合。

### P1-3 Context Trace 只展示结果，不展示决策

当前能看到最终 system segments 和压缩结果，但看不到候选来源、淘汰原因、段预算、历史来源和工具 schema token。目标契约以 `lib/agent/context/plan.ts` 和 `lib/agent/context/types.ts` 为准。

### P1-4 大量非结构化日志无法聚合

Agent 相关路径存在大量非结构化控制台输出。日志格式、字段和级别不统一，部分日志直接输出消息预览、原始模型 usage 或搜索结果。

建议引入轻量结构化 logger：

```json
{
  "level": "warn",
  "event": "memory.recall.failed",
  "runId": "...",
  "requestId": "...",
  "sessionId": "...",
  "stage": "context.memory",
  "durationMs": 83,
  "errorClass": "dependency",
  "retryable": true
}
```

默认禁止记录完整 Prompt、用户原文、token、cookie 和外部工具原文。

### P1-5 降级路径上报不全（核心健康信号缺失）

系统的架构哲学是「永不崩，只降级」——**降级率因此是这套系统最好的健康指标**，但当前只有 route 和 plan 的降级打了 Langfuse WARNING，以下降级点静默发生：

| 降级点 | 现状 | 位置 |
|---|---|---|
| 语义压缩 → 确定性回退 | `fallbackReason` 只进 trace step，Langfuse 无感知；此回退意味着压缩质量骤降 | `compaction.ts:428` |
| RAG keyword RPC 缺失 → 纯向量 | 只 console | `retriever.ts:250` |
| 模型 usage 缺失 → 本地估算记账 | 静默发生，记账口径变化不可见 | `runtime/index.ts:1224` |
| 工具限流/超时 | tool step 有 error 字符串，无分类聚合 | `tool-router.ts` |

修法：抽统一的 `reportDegradation(kind, detail)` 工具——内部同时打 Langfuse WARNING event + 计数器，所有降级点换用。这是 §7 告警中「语义压缩 fallback 比例 > 10%」等条目的数据源前置。

### P2-1 没有服务级 Metrics、SLO 和告警

当前 metrics 存在于单条 Trace JSONB，主要用于详情页和 `/usage`。没有时序 Counter/Histogram/Gauge，也没有：

- 完成率和各类终止率；
- p50/p95/p99 总延迟及分阶段延迟；
- provider/tool/RAG/memory 错误率；
- 压缩率和语义压缩降级率；
- Trace 写入失败率；
- 当前运行数、排队数和等待用户数；
- 预算超限、成本异常和 cache 命中率趋势。

`/usage` 读取最多 1000 条 Trace 并在应用层扫描 JSONB，适合当前个人使用，不适合作为生产指标系统。

### P2-2 缺少健康检查和依赖状态

没有统一 `/api/health` 或 readiness 检查来区分：应用存活、Supabase 可用、Redis 可用、模型 provider 可用、Langfuse exporter 是否积压。

### P2-3 OTel 初始化缺少生产属性和生命周期治理

`instrumentation.ts` 只注册 Langfuse span processor 并直接启动 SDK，没有明确配置：

- `service.name/service.version/deployment.environment`；
- tenant/workspace 的安全属性策略；
- input/output 采集策略；
- sampling；
- exporter flush/shutdown；
- 初始化幂等和开发热更新行为。

### P3-1 Eval 规模不足，Trace 不能形成质量闭环

通用 Agent Eval 只有 3 条基础 case，主要断言是否调用工具、是否完成和模型轮数；RAG Eval 也仍是小规模静态集合。缺少：

- Prompt Injection；
- 上下文压缩保真；
- Planner 质量；
- 工具失败、重试和跳过；
- 长任务和中断恢复；
- 记忆写入/冲突；
- 成本和延迟回归；
- 线上 Trace Replay；
- 用户反馈回流。

### P3-2 Trace 数据治理不完整

本地 Trace 会保存 system prompt、工具输入、工具结果摘要和 RAG debug。API 查询虽然按 user 过滤，但当前 schema 文档没有定义完整的 RLS、脱敏、保留期、访问审计和删除策略。

企业环境必须区分：

- 默认结构化元数据；
- 脱敏后的内容摘要；
- 受限访问的原始 payload；
- 只保存 hash/reference 的敏感内容；
- 不允许进入任何观测系统的 secret。

## 5. 目标观测模型

### 5.1 顶层 Run

```ts
type AgentRunTrace = {
  schemaVersion: number;
  runId: string;
  requestId: string;
  sessionId?: string;
  parentRunId?: string;
  userIdHash?: string;
  workspaceId?: string;
  otelTraceId?: string;
  rootSpanId: string;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  terminalReason?: string;
  startedAt: number;
  endedAt?: number;
  release: ReleaseDescriptor;
  contextPlanId?: string;
  metrics: RunMetrics;
};
```

### 5.2 Span 层级

```text
agent.run
  +-> request.parse
  +-> context.session.restore
  +-> context.knowledge-profile
  +-> context.memory.recall
  +-> context.prompt.build
  +-> planner.generate
  |     \-> planner.repair
  +-> plan.step
  |     +-> context.compact
  |     +-> model.call
  |     +-> tool.call
  |     |     \-> retrieval.* / external.http / approval.wait
  |     \-> step.verify
  +-> final_answer.model
  +-> memory.consolidate
  +-> session.persist
  \-> trace.persist
```

### 5.3 事件与 Span 的边界

- **Span**：有开始和结束、需要计算耗时的操作；
- **Event**：发生在 Span 内的瞬时事实，例如预算告警、fallback、用户取消；
- **Metric**：跨大量 Run 聚合的趋势；
- **Audit Event**：谁批准了什么副作用，独立于调试 Trace，必须 append-only；
- **Eval Result**：对某个版本和数据集的质量判断，不应混入生产 Trace。

## 6. 必须建设的 Metrics

### 6.1 可靠性

| 指标 | 建议标签 |
|---|---|
| `agent_runs_total` | status, terminal_reason, mode, model |
| `agent_run_duration_ms` | status, mode |
| `agent_stage_duration_ms` | stage, status |
| `agent_errors_total` | stage, error_class, retryable |
| `agent_trace_persist_total` | status |
| `agent_cancel_total` | stage |

### 6.2 模型和成本

| 指标 | 建议标签 |
|---|---|
| `model_calls_total` | provider, model, operation, status |
| `model_latency_ms` | provider, model, operation |
| `model_tokens_total` | model, direction, cache_status |
| `model_cost_cny_total` | model, operation, workspace |
| `model_fallback_total` | from_model, to_model, reason |

### 6.3 Agent 行为

| 指标 | 建议标签 |
|---|---|
| `tool_calls_total` | tool, status, error_class |
| `tool_latency_ms` | tool, status |
| `plan_generation_total` | status, used_repair, used_fallback |
| `plan_step_total` | status, retry_count |
| `agent_budget_exceeded_total` | budget_type |
| `agent_repeated_tool_call_total` | tool |
| `approval_wait_duration_ms` | tool, decision |

### 6.4 上下文、RAG 和记忆

| 指标 | 建议标签 |
|---|---|
| `context_tokens` | source, decision |
| `context_compaction_total` | method, status, fallback_reason |
| `context_compression_ratio` | method |
| `rag_requests_total` | mode, status, no_result |
| `rag_latency_ms` | stage |
| `memory_recall_total` | status, hit |
| `memory_write_total` | decision, status |

注意：高基数的 `runId/userId/sessionId/query/toolCallId` 只能进入 Trace/Log，不能作为 Metric label。

## 7. 初始 SLO 与告警

| SLO | 初始目标 |
|---|---:|
| 已接受 Run 具有 terminal Trace | >= 99.9% |
| 本地 Trace 与 OTel 关联成功率 | >= 99.9% |
| 未分类 terminal error | 0 |
| 普通对话成功率 | >= 99% |
| 模型调用成功率 | >= 99.5% |
| 安全工具未经审批执行 | 0 |
| Trace 脱敏策略覆盖率 | 100% |
| p95 首事件延迟 | < 2 秒 |

首批告警：

- 5 分钟模型错误率 > 5%；
- 15 分钟 `budget_exceeded` 或 `repeated_tool_call` 高于基线 3 倍；
- Trace terminal 写入比例 < 99.9%；
- 语义压缩 fallback 比例持续 > 10%；
- RAG no-result 比例或工具错误率异常上升；
- 单 workspace 每小时费用超过动态阈值。

## 8. 本地实现与现成平台的边界

### 必须由项目自己定义

- `AgentRunTrace/AgentSpan/StructuredError` 语义；
- Agent 生命周期和 terminal reason；
- `ContextPlan`、Plan、Tool、Memory、Approval 事件；
- Prompt/tool/policy/release 版本；
- 脱敏、采样和数据保留规则；
- Eval case、断言、Replay 输入和行为 diff；
- 业务 SLO、错误分类和告警阈值。

### 可以交给 Langfuse/OTel/监控平台

- Span 传输、存储和查询；
- Trace 时间线和跨服务拓扑；
- Dashboard、聚合、告警通知；
- 数据集、人工标注和 judge 运行托管；
- OTel Collector 的采样、路由和多后端导出；
- 基础设施日志和时序指标存储。

不建议删除本地 Agent Trace、只依赖 Langfuse。Langfuse 负责观测平台，本项目仍需拥有 Agent 领域事件契约、审计语义和可重放数据。

## 9. 分阶段实施

### §9.0 快速落地批次（按成本排序，可穿插在下述阶段前先行）

来自代码审查执行清单的低成本先行项，每批映射到本文阶段与[企业路线图](../roadmap/enterprise-agent-roadmap.md)：

| 批次 | 内容 | 成本 | 映射 |
|---|---|---|---|
| 1（一天内可完成） | Langfuse↔trace 双向关联最小解（P0-4）；降级统一上报 `reportDegradation`（P1-5）；工具执行 Langfuse span（§3 覆盖矩阵）；systemPrompt 去重为 trace 级一份 + step 存 hash（`trace.ts:29-42`，8 轮循环 = 8 份拷贝的 JSONB 膨胀，hash 顺便为版本归因铺路） | 全部 S | 本文 P0-4/P1-5/P1 |
| 2 | MemoryTraceStep：recall 记 query/是否被意图门控拦截/hits+scores/注入与否，write 记决策（`route.ts:342`、`memory-flow.ts`，与企业路线图 P2 记忆改造同步做）；partial trace 落库（P0-3 最小解）；`omittedSegments` 进 trace（`pipe.ts:34` 返回值当前被丢弃）；ToolTraceStep 加 `errorClass` | S~M | 本文 P0-1/P0-3/P1-3；企业路线图 M1/E4 前置 |
| 3 | 指标 rollup（`lib/agent/ops/metrics.ts`，**用现成 scheduler 跑每日 rollup** 落 `agent_metrics_daily`）+ `/api/health` + 阈值告警走 scheduler 已有 webhook 通道 + /usage 页加健康视角（stopReason 饼图、工具错误 TopN、降级事件列表） | M | 本文 P2-1/P2-2；企业路线图 E11 第一步 |
| 4 | 统一 runId/span 树、ReleaseDescriptor、结构化 logger 全量替换、增量事件表、retention | L | 本文 P0-4 完整解/P1-1/P1-2/P4；与企业路线图 E9/E7 合并实施，不单独立项 |

### P0：Trace 完整性（2-4 天）

1. 在请求边界创建统一 run；
2. 增加 `aborted/error` 等准确终止语义；
3. Planner、最终总结和异常路径进入本地 Trace；
4. Trace 从 insert 改为 start + terminal upsert；
5. 保存失败增加计数、重试和明确日志；
6. 修正工具步骤真实开始时间。

验收：任何已接受请求都能查到一个状态明确的 run，且没有 `completed=false + stopReason=completed`。

### P1：关联、层级与版本（3-5 天）

1. 引入 `runId/spanId/parentSpanId`；
2. 保存 OTel trace id 并支持跳转 Langfuse；
3. 增加 `schemaVersion` 和 `ReleaseDescriptor`；
4. 工具、RAG、记忆、审批和持久化成为正式 span；
5. 引入 `ContextPlan` 并避免每个模型 step 重复存完整 system prompt。

验收：从本地任一 run 可以定位 Langfuse，同一 Plan 的并行/串行关系可以还原。

### P2：结构化日志、Metrics 和 SLO（3-5 天）

1. 替换 Agent 关键路径 console 日志；
2. 接入 OTel Metrics 或 Prometheus 兼容 exporter；
3. 建立 run/model/tool/context/RAG 四组 dashboard；
4. 增加 liveness/readiness/dependency health；
5. 建立首批告警和运行手册。

验收：无需查询单条 Trace，即可判断系统当前是否健康、哪一阶段正在退化。

### P3：Eval、Replay 和发布门禁（1-2 周）

1. 通用 Agent Eval 扩展到至少 30 条；
2. 增加 context/security/failure/plan/memory 数据集；
3. 从线上 Trace 生成脱敏 replay fixture；
4. 对 Prompt、模型和策略版本执行行为 diff；
5. mock eval 进入 CI，live/judge eval 进入 nightly；
6. 质量、成本或安全退化超过阈值时阻断发布。

### P4：数据治理与运营（持续）

1. Trace 字段级脱敏和 secret detector；
2. metadata/content/raw payload 分层存储；
3. 按环境、错误和用户反馈实施采样；
4. 设置 Trace、审计和原始内容保留期；
5. 增加 Trace 查看和导出的访问审计；
6. 用户删除时级联清理本地与 Langfuse 数据。

## 10. 建议先做的十项任务

按收益和依赖排序：

1. 修复 abort/错误终止语义；
2. 把 Trace 创建提升到 `/api/chat` 请求边界；
3. Planner 和 final answer 纳入同一 Trace；
4. Trace 改为 start + terminal upsert，并监控写入失败；
5. 引入 canonical `runId` 与 OTel trace id 映射；
6. 增加 Trace schema 和 release 版本；
7. 建立结构化 logger 和统一错误分类；
8. 实现 `ContextPlan` 观测；
9. 导出核心 Counter/Histogram 并建立 SLO 面板；
10. 扩充 Eval 并实现第一版 Trace Replay。

## 11. 完成标准

当系统能够稳定回答以下问题时，可观测性才算进入生产阶段：

- 这次请求在哪个阶段失败，错误是否可重试？
- 用户取消和系统失败是否能被准确区分？
- Planner、模型、工具、RAG、记忆和最终回答是否属于同一个 run？
- 本地 Trace、Langfuse Span、日志和指标是否能相互跳转？
- 这次行为使用了哪版代码、Prompt、工具、上下文和模型配置？
- 为什么某段上下文被保留、压缩或丢弃？
- 最近一小时成功率、p95 延迟、工具错误率和费用是否异常？
- 一次线上失败能否脱敏后重放，并验证修复没有引入其他退化？
- Trace 中是否可能出现 secret、敏感信息或越权可见内容？
- 观测平台本身丢数据时，系统是否能检测和告警？

## 12. 面试视角速记

- 「明细层超配、聚合层空缺是个人项目的通病——我的补法不是引入重型监控栈，而是用已有的 trace 表 + 自己的调度器做每日 rollup，`/api/health` 一个端点回答『系统这周健康吗』。」
- 「降级率是这套系统最好的健康信号：架构哲学是永不崩只降级，那么每个降级点都必须可上报可聚合，否则系统在悄悄变差而无人知道。」
- 「双层可观测（领域 trace + Langfuse）各有职责，但必须能互跳——一个 id 两行代码的事，排障体验差一个数量级。」
- 「abort 时 `stopReason="completed"` 会污染完成率——状态和终止原因必须是两个独立字段，这是把可观测数据当统计口径用时才会暴露的设计问题。」
- 「『trace 即评测断言载体』是这套系统最大的观测资产，所有改进都建立在它之上而不是另起炉灶。」
