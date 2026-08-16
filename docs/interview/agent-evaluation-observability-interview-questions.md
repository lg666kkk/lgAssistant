# Agent 评估与可观测性面试题库（结合当前项目代码）

> 以面试官视角整理，结构参考 [RAG 面试题库](./rag-interview-questions.md)，按真实面试节奏逐层深入：概念边界 -> Trace 设计 -> 离线评估 -> 记忆专项评估 -> 线上监控 -> 可靠性与治理 -> 代码深挖 -> 故障排查与演进。
> 每题给出「想听」「项目落点」或「追问」。回答时建议使用“当前实现 -> 设计原因 -> 已知边界 -> 验证指标 -> 下一步演进”五段结构，不把 Langfuse、Trace UI 或少量通过的测试直接等同于生产级质量体系。
> 核心代码：`lib/agent/runtime/trace.ts`、`lib/agent/eval/`、`app/api/chat/route.ts`、`lib/agent/memory/`；现状设计见 [observability-trace-eval.md](../agent/observability/observability-trace-eval.md) 和 [agent-observability-improvement-plan.md](../agent/observability/agent-observability-improvement-plan.md)。

---

## 当前模块功能总结

本项目已经形成“本地执行轨迹 + Langfuse/OTel + 离线 Eval + 在线 Score”的原型闭环，但还不是请求级、可重放、带发布门禁的完整质量平台：

```text
请求观测：/api/chat 生成 requestId -> Langfuse 根 observation
    -> RAG route / memory forget / recall / consolidate observations
    -> Planner 或 runAgentLoop -> model / tool / compaction / plan / retrieval steps
    -> answer validation -> 本地 agent_traces + Langfuse online scores

离线评估：固定 EvalCase -> mock 编排测试（默认）/ live 模型测试（显式开启）
    -> runAgentLoop -> 行为断言 -> Langfuse Dataset / Dataset Run

RAG 专项：routing cases + retrieval golden set + groundedness cases
记忆专项：策略与存储测试 + 聚合观测；尚缺独立 memory golden set 和端到端门禁
```

面试时必须主动说明这些真实边界：

- `AgentTrace` 是执行器级 Trace，在 `runAgentLoop()` 或 `executePlan()` 内创建；Langfuse 根 observation 覆盖了更早的路由和记忆阶段，但本地 Trace 仍不是完整请求生命周期。
- 本地 Trace 已记录 model、tool、context compaction、plan、retrieval、answer validation，并保存 token、费用估算、工具耗时和 ContextPlan；步骤仍是平铺时间线，不是真正的 span tree。
- `/api/chat` 会等待保存最终 `pendingTrace`，再上报 Langfuse online scores；但 trace 表仍只有 `completed + stop_reason` 的粗粒度终态，没有结构化 error class、retryability、release descriptor 和统一的 OTel 关联字段。
- `instrumentation.ts` 已用 OpenTelemetry NodeSDK 注册 Langfuse span processor；尚未显式定义 service/version/environment、采样、脱敏策略和 shutdown/flush 生命周期。
- 通用 Agent Eval 只有 3 条 live case，默认执行的 mock 轨只有 1 条编排测试；它验证工具调用和循环行为，不足以证明生产答案质量。
- Langfuse Dataset 能同步 Agent 与 routing cases，但 Agent 执行边界仍是 `runAgentLoop`，没有经过认证、会话恢复、记忆召回、Prompt Pipe、SSE、持久化等 `/api/chat` 生产路径。
- 在线 Score 包含完成状态、工具失败率、模型调用次数、延迟；有答案校验时再记录 groundedness、citation precision、citation coverage 和 evidence status。这些是代理信号，不是人工标注的真实正确率。
- 记忆已有抽取校验、写入决策、召回重排和 Langfuse 聚合 observation，但缺 extraction/decision/recall/end-to-end 的版本化 golden set、跨租户安全门禁和 durable consolidation 的恢复指标。

---

## 使用方式

每题先练 60-90 秒主回答，再接受追问。项目题优先引用真实代码路径和当前数据规模；指标题先说它回答什么问题，再说它不能回答什么问题。

建议把回答分成五层：

1. **目标**：要判断正确性、可靠性、安全、成本还是体验。
2. **观测单元**：Run、Span、Event、Metric、Log、Score 各承担什么。
3. **当前实现**：代码在哪个边界采集，数据写到哪里。
4. **证据与限制**：样本量、评估边界、judge 偏差和数据缺口。
5. **决策闭环**：阈值、告警、回放、灰度或发布门禁如何消费结果。

---

## 第一层：概念与边界（判断是否真正理解）

### Q1. Agent 的可观测性和普通后端日志有什么不同？

- **想听**：普通日志主要回答错误和状态；Agent 还要解释模型为什么调用某个工具、看到了什么上下文、检索了什么证据、在哪个决策点降级，以及质量、成本、延迟之间的关系。
- **追问**：可观测不等于保存完整 Prompt。敏感内容应默认脱敏、摘要化或只保存引用。

### Q2. Trace、Log、Metric、Eval、Online Score 分别解决什么问题？

- **想听**：Trace 还原单次因果链；Log 记录离散事件；Metric 看群体趋势和 SLO；Eval 用固定数据判断行为/质量；Online Score 给线上 Run 附加代理质量信号。它们互补，不能用 Trace UI 代替指标系统。

### Q3. 为什么“接入 Langfuse”不等于完成 Agent 可观测性？

- **想听**：平台能存储和展示数据，但 Run/Span 语义、错误分类、租户字段、版本信息、脱敏规则、SLO 和告警仍必须由业务定义。
- **项目落点**：项目已接 Langfuse/OTel，但本地 `AgentTrace` 与外部 trace 尚无持久化的统一 trace ID。

### Q4. Agent Eval 和普通单元测试有什么区别？

- **想听**：单元测试适合确定性函数和协议；Eval 处理模型输出的非确定性，用数据集、rubric、统计分布和多次运行判断质量。安全约束和结构契约仍应尽量写成确定性测试。

### Q5. 离线 Eval、在线 Eval 和 A/B Test 的边界是什么？

- **想听**：离线 Eval 快速、可重放，适合回归；在线 Eval 反映真实分布但标签稀疏；A/B Test 判断真实用户与业务结果。三者要通过 case、trace 和版本关联起来。

### Q6. 为什么 Agent 不能只用“最终答案正确率”评估？

- **想听**：Agent 是多阶段系统。最终答对可能是检索错但模型猜对；最终答错可能是工具正确但生成失败。应拆成路由、计划、工具、检索、记忆、生成、安全、成本和恢复能力。

### Q7. 什么叫可操作的观测信号？

- **想听**：信号必须能映射到负责人和动作。例如 tool timeout rate 上升触发依赖排查；memory recall false positive 上升触发门控/阈值回滚。只有一条“质量下降”总分不可操作。

### Q8. `requestId`、`runId`、`traceId`、`sessionId` 应如何区分？

- **想听**：requestId 标识入口请求，runId 标识一次业务执行，traceId 标识分布式追踪，sessionId 表示跨 Run 会话。当前项目主要以 `requestId` 贯穿执行，本地还没有独立 canonical runId 和持久 OTel traceId。

---

## 第二层：Trace 与运行时观测（核心能力）

### Q9. 讲一下当前项目一次请求的观测链路。

- **项目落点**：`/api/chat` 创建 `requestId` 和 Langfuse 根 observation；记录 RAG route、记忆忘记/召回/沉淀；Planner 或 Agent Loop 产生本地步骤；答案证据校验后保存 `agent_traces`，再把在线评分绑定到 Langfuse trace。

### Q10. 为什么 Trace 应在 API 请求边界创建，而不是在 Agent Loop 内创建？

- **想听**：否则看不到认证、会话恢复、记忆召回、Prompt 构建、Planner 失败、SSE 中断和最终持久化。执行器级 Trace 适合局部调试，不足以表达一次用户请求。
- **项目边界**：Langfuse 根 observation 已覆盖请求主体，但本地 `AgentTrace` 仍从执行器内部创建。

### Q11. 当前 `TraceStep` 的判别联合有什么价值？

- **想听**：`type` 将 model/tool/compaction/plan/retrieval/validation 的字段约束在各自类型中，UI 和分析代码可穷尽分支，避免一个充满可选字段的弱类型对象。

### Q12. 平铺步骤和 span tree 有什么本质区别？

- **想听**：平铺步骤能还原顺序，但无法准确表达 Planner -> Step -> Model -> 并行 Tools 的父子关系和时间重叠。span tree 需要 spanId、parentSpanId、start/end/status 和 links。

### Q13. 并行工具调用在 Trace 中应该怎样表示？

- **想听**：每个工具是同一父 span 下的独立子 span，使用真实开始/结束时间；聚合延迟看 critical path，不能简单把所有 duration 相加。

### Q14. `completed` 和 `stopReason` 为什么不能混成一个字段？

- **想听**：状态表示 succeeded/failed/cancelled/waiting，reason 表示 end_turn、awaiting_confirmation、max_tokens、tool_error 等原因。当前项目已支持 `aborted/error`，但仍只有布尔完成态，错误阶段和 retryability 不够结构化。

### Q15. 工具错误应该记录哪些结构化字段？

- **想听**：tool name、stage、error class/code、dependency、retryable、attempt、timeout、input schema version、duration、fallback 和用户影响；原始 secret、token 与敏感 payload 不应写入。

### Q16. Context 可观测性应该记录什么？

- **想听**：候选来源、每段预算、保留/淘汰原因、压缩前后 token、summary 方法、fallback、ContextPlan/policy version 和 artifact 引用。仅保存最终 system prompt 无法解释决策。
- **项目落点**：当前有 `ContextPlan`、system segments 和 compaction step，但缺完整候选决策链和统一 release descriptor。

### Q17. 降级为什么必须成为一等观测事件？

- **想听**：系统“还能回答”不等于健康。语义压缩回退、RAG 降为单路、usage 估算、记忆召回跳过都可能让错误率不升但质量悄然下降；应记录 degradation kind、reason、affected stage 和 fallback result。

### Q18. 本地 Trace 与 Langfuse 应如何关联？

- **想听**：生成 canonical runId，写入本地表、OTel attributes、Langfuse metadata 和结构化日志；持久化 otelTraceId/rootSpanId，支持双向跳转和缺失对账。

---

## 第三层：离线评估与数据集（大多数候选人容易说空）

### Q19. 当前通用 Agent Eval 真实验证了什么？

- **项目落点**：3 条 live case 覆盖时间工具、计算器和纯聊天；默认 mock 测试只验证 calculator 两轮编排。断言包含工具名、完成态、最大模型调用数和工具无错误。
- **边界**：它验证最小执行协议，不证明回答事实正确、规划合理、记忆有效或生产路由可用。

### Q20. 为什么 mock Eval 和 live Eval 都需要？

- **想听**：mock 快、稳定、能精确注入异常，适合 CI；live 能发现模型路由、Prompt 和 provider 行为变化，但有成本、抖动和凭据依赖。二者失败含义不能混报。

### Q21. 为什么当前 `runCase()` 的评估边界值得警惕？

- **项目落点**：runner 直接调用 `runAgentLoop()`，绕过 `/api/chat` 的认证、恢复、记忆、Prompt Pipe、Planning dispatch、SSE、答案流和持久化。因此通过只能说明 runtime 局部通过。

### Q22. 如何设计 Agent Golden Set？

- **想听**：从真实任务和失败 Trace 采样，覆盖工具选择、参数、顺序、多步计划、拒绝、确认、失败恢复、记忆、RAG、长上下文与安全；按任务类型、语言、难度和风险切片，并留出冻结测试集。

### Q23. Eval Case 应保存哪些版本信息？

- **想听**：dataset/case/rubric version、model/provider、prompt、tool schema、context policy、retrieval index、memory policy、app commit 和运行参数。没有版本就不能解释回归。

### Q24. 如何评估工具调用，不能只看“是否调用过”？

- **想听**：还要看是否该调用、工具选择、参数正确性、调用顺序、重复调用、确认策略、失败处理、结果是否被答案正确使用，以及成本/延迟。

### Q25. 如何评估 Plan-and-Execute？

- **想听**：plan necessity、步骤覆盖、依赖顺序、allowed tools、success criteria 可验证性、执行偏差、失败重规划和最终任务成功率；简单任务还要惩罚过度规划。

### Q26. LLM-as-a-Judge 适合评什么，不适合评什么？

- **想听**：适合语义正确性、帮助度、风格和证据蕴含的规模化初筛；不适合单独裁决安全红线、精确数值、跨租户和确定性协议。需要清晰 rubric、参考证据、盲测、校准集和人工一致性检查。

### Q27. 如何处理 live Eval 的非确定性？

- **想听**：固定可控参数，重复 N 次看 pass distribution，报告均值/方差/置信区间；关键 case 使用通过率下限，比较候选版本与基线而不是迷信单次结果。

### Q28. 如何做 ablation，证明一个 Agent 优化真的有价值？

- **想听**：固定数据集和版本，只切换一个能力，例如 planning、memory、rerank 或 compaction；同时比较任务成功、安全、成本和 p95 延迟，按 case 类型检查收益和退化。

---

## 第四层：记忆系统专项评估（结合本项目重点）

### Q29. 为什么记忆系统必须分层评估？

- **想听**：写入错、决策错、召回错和模型使用错是不同问题。应拆 extraction -> policy/decision -> persistence -> recall/rank -> context injection -> answer use -> forgetting。

### Q30. 记忆抽取应该看哪些指标？

- **想听**：fact precision/recall、主体归属、evidence exactness、key/type/source accuracy、敏感信息拒写率和一次性信息误写率。只数“写了几条”没有质量含义。

### Q31. 如何评估 `ADD/UPDATE/INVALIDATE/NOOP` 决策？

- **想听**：给新事实、重复、纠正、否定、key 漂移和含糊候选标 gold action/target key；统计 action accuracy、target accuracy、误覆盖和漏失效，安全上宁可含糊 NOOP 也不能误删。

### Q32. 记忆召回应该看哪些指标？

- **想听**：门控 precision/recall、candidate Recall@K、MRR/nDCG、selected precision、irrelevant injection rate、conflicting-memory rate、token cost 和 latency；门控未触发与向量未命中要分开统计。

### Q33. 如何证明记忆改善了最终回答？

- **想听**：同一 case 做 memory on/off，比较任务成功、事实正确、偏好满足和跨会话连续性；同时测过度个性化、旧事实污染、隐私惊讶和额外 token/延迟。

### Q34. 记忆 Eval 数据集至少要覆盖哪些 case？

- **想听**：显式偏好、隐式推断、一次性状态、第三人称事实、秘密、同义 key、纠正、否定、显式忘记、含糊删除、时间变化、跨语言、Prompt Injection、跨租户和不需要个性化的普通问题。

### Q35. 如何评估记忆遗忘是否成功？

- **想听**：不仅看 API 返回，还要验证 canonical row、向量索引、缓存、Prompt 注入、后续回答、Trace/派生数据和合规删除范围；报告 forget success、time-to-forget、残留率和失败重试。

### Q36. 当前项目对记忆观测已经记录了什么？

- **项目落点**：`memory.recall` 除 eligible、candidate/selected、类型/来源外，还记录 Qwen reranker 的候选正文、分阶段分数与排序变化，并同步进入本地 Trace；保存前统一脱敏。`memory.consolidate` 记录 extracted/persisted/invalidated/skipped/failed 和 decision counts；显式忘记记录状态和失效数量。

### Q37. 当前记忆观测还缺什么？

- **想听**：durable job ID、队列延迟/积压、attempt、embedding latency/cost、逐阶段耗时、策略/模型版本、两表一致性检查、质量标签和从后台任务回链原 Run 的可靠关联。

### Q38. 为什么不能把完整记忆正文写进 Trace 来方便排查？

- **想听**：记忆是高敏感用户画像，观测平台通常访问面更大、保留更久。默认记录 ID/hash、类型、来源、动作、计数和错误类；原文只在授权、短保留、可审计的受限通道查看。

---

## 第五层：Online Evaluation、Metrics 与 SLO

### Q39. 当前 Online Score 有哪些，能说明什么？

- **项目落点**：完成状态、工具错误率、模型调用数、端到端耗时；存在答案校验时追加 groundedness、citation precision/coverage 和 retrieval evidence status。
- **边界**：这些能做趋势和异常检测，不能直接当作用户任务成功率。

### Q40. 为什么 `agent_completed=1` 不是质量指标？

- **想听**：完成只说明走到某个终态，答案可能错误、无关、过度调用工具或违反安全策略。应与 task success、judge score、用户反馈和业务 outcome 联合。

### Q41. Agent 服务最少应该有哪些 RED/USE 类指标？

- **想听**：请求率、成功/失败/取消/等待率、p50/p95/p99 延迟；运行中/排队/资源饱和；再按 provider、model、tool、RAG、memory、planner、compaction 分阶段统计。

### Q42. 成本监控应该怎样设计？

- **想听**：按 Run、用户/租户、模型、功能和版本统计 input/output/cache tokens、模型费用、工具费用；看每成功任务成本而不只看每请求成本，并设置突增和预算告警。

### Q43. 为什么降级率可能比错误率更能反映健康？

- **想听**：fallback 会把硬错误变成表面成功。应监控 semantic compaction fallback、RAG route degradation、memory recall skip/failure、usage estimation 和 provider fallback，并和质量变化关联。

### Q44. 如何为 Trace 完整性定义 SLO？

- **想听**：例如“已接受的 Run 中，具有 terminal status 的持久 Trace 比例 >= 99.9%”；另看 trace write latency、缺 span 比例、外部/本地关联成功率和迟到事件率。

### Q45. 线上没有标准答案，怎么发现质量漂移？

- **想听**：监控路由/工具/拒答/降级分布、judge 抽样、用户反馈、重问率和任务业务指标；从异常 cohort 抽样人工标注，回流到冻结 Eval Set。代理指标只能触发调查。

### Q46. 告警阈值应该固定还是动态？

- **想听**：安全和数据泄漏用固定零容忍；延迟、成本、路由分布可结合 SLO、历史基线和变化率。告警要按版本/租户/模型切片，避免全局均值掩盖局部故障。

---

## 第六层：可靠性、安全与数据治理

### Q47. 为什么 Trace 持久化不能一直 best-effort？

- **想听**：崩溃、超时和中断恰恰最需要 Trace；fire-and-forget 会在短生命周期运行时丢失。应在请求边界写 running、统一 finally 写 terminal，或用 outbox/collector 重试并进入 DLQ。
- **项目落点**：最终 `pendingTrace` 已被等待保存，但执行器创建之前和突发进程退出仍有缺口。

### Q48. 网络超时后不知道 Trace 是否写成功，如何保证幂等？

- **想听**：以 runId/requestId 加唯一约束并 upsert，事件带 eventId/sequence；重试不创建重复 Run，乱序 span 可合并，terminal 状态使用版本或状态机防旧写覆盖。

### Q49. Trace 中的 Prompt、工具输入和结果如何做数据分级？

- **想听**：默认结构化 metadata；脱敏摘要；受限原始 payload；仅 hash/reference；禁止采集 secret。每类定义访问控制、保留期、审计和删除策略。

### Q50. 多租户 Trace 查询为什么必须 fail closed？

- **想听**：服务端使用高权限客户端时，RLS 可能被绕过，列表、详情、删除和导出都必须显式 user/workspace filter；缺 tenant scope 应拒绝查询而不是查全量。
- **项目落点**：当前 traces API 的读删路径都按 `user_id` 过滤。

### Q51. 采样会不会让故障 Trace 丢失？

- **想听**：可以使用 head sampling 控成本，tail sampling 保留 error/slow/security/degraded Run；关键审计事件不能依赖概率采样。采样策略本身也要版本化和可观测。

### Q52. OpenTelemetry SDK 生命周期要注意什么？

- **想听**：初始化幂等、资源属性、batch processor、exporter 超时、队列上限、flush/shutdown、serverless 行为和 exporter 自身健康。采集失败不能阻塞主链路，但必须有自监控。

### Q53. Trace 保留 30 天是否足够？

- **想听**：没有统一答案。要根据排障周期、合规、成本和内容敏感度分层；聚合指标可长留，原始内容短留，安全审计按法规。项目有 `retention_until` 和清理函数，但完整治理仍需部署与策略验证。

### Q54. 如何防止观测系统成为新的 Prompt Injection 或数据外泄通道？

- **想听**：外部内容只作为数据展示，UI 转义；禁止把 Trace 内容自动拼回高权限 Prompt；导出和搜索做授权；secret/DLP 在采集前执行；工具重放必须重新经过 policy/approval。

---

## 第七层：项目代码深挖（验证是不是亲手做过）

### Q55. 为什么 `saveTrace()` 先脱敏再写 JSONB？还有什么风险？

- **项目落点**：`trace-store.ts` 对 steps/metrics 调用 `redactSensitiveValue()`，并设置 retention；风险是 system segment、嵌套对象和新字段可能突破规则，需要 schema allowlist、测试和内容分级，而不只依赖通用递归脱敏。

### Q56. `buildOnlineScores()` 为什么只取最后一个 `answer_validation`？

- **想听**：一次 Run 可能经过计划步骤或多段生成，最终评分应对应最终答案；但仅按“最后出现”依赖平铺顺序，span tree 下应显式关联 answerId/parent span。

### Q57. 为什么在线评分要在 Trace 保存后再上报？

- **项目落点**：本地 Trace 是审计基础，Langfuse score 是附加能力；评分失败不能影响聊天。当前代码还调用 `flushAsync()`，降低短生命周期进程丢分风险，但会增加终态路径延迟。

### Q58. Langfuse Dataset 的稳定 item ID 有什么价值？

- **项目落点**：代码按 dataset + kind + caseId 做 SHA-256 截断，重复同步可更新同一逻辑 case，避免每次生成重复数据；case 内容变更仍应显式记录版本。

### Q59. `test:eval` 通过时应该怎样准确汇报？

- **想听**：报告 mock/live 数量、跳过数量、是否真实调用模型、执行边界和数据集版本。当前默认结果主要是 1 条 mock 编排测试通过，3 条 live case 在未设置 `EVAL_LIVE=1` 时跳过。

### Q60. 为什么 `/usage` 扫描 Trace JSONB 不适合规模化监控？

- **想听**：应用层扫描有查询上限、聚合成本和时间序列能力不足；生产应把 Counter/Histogram 发送到 metrics backend，Trace 详情只做 exemplars 和深挖。

### Q61. 当前 `instrumentation.ts` 最值得补哪些字段？

- **想听**：`service.name`、`service.version`、`deployment.environment`、region、release/commit；再补采样、内容采集策略、exporter 队列和 shutdown。tenant/user 属性必须脱敏并控制基数。

### Q62. 为什么 ReleaseDescriptor 对 Eval 和线上排障都重要？

- **想听**：模型、Prompt、工具 schema、ContextPolicy、RAG index、memory policy 或代码任一变化都可能改变行为。没有完整版本描述，就无法归因、重放、对比或可靠回滚。

---

## 第八层：线上故障、发布门禁与演进

### Q63. 线上完成率稳定，但用户点踩突然上升，你怎么排查？

- **排查顺序**：按 release/model/tenant 切片 -> 看降级、路由、工具、检索、记忆注入和 token/cost 分布 -> 抽样失败 Trace -> 人工标注失败阶段 -> 回放到离线 Eval -> 做单变量 ablation -> 灰度修复。

### Q64. Trace 数量突然下降 50%，但 API 流量没变，怎么定位？

- **想听**：先对比 accepted request、root observation、本地 terminal trace 和 exporter received 四个计数；检查 save failure、数据库/retention、采样、exporter 队列、SDK 初始化和部署版本。不要先假设用户流量下降。

### Q65. 工具错误率升高，但最终答案成功率不变，是否可以忽略？

- **想听**：不能。可能是重试/fallback 掩盖故障，成本和延迟已经恶化；按工具和 error class 查看 attempts、fallback 和 critical path，并设置 error budget。

### Q66. Memory recall selected count 突然接近 0，如何排查？

- **排查顺序**：eligible 门控分布 -> embedding/provider -> RPC/tenant filter -> active/confidence 过滤 -> similarity 阈值 -> rerank -> Prompt budget -> 发布中的 memory policy/embedding/index 版本。

### Q67. 如何把 Eval 变成发布门禁？

- **想听**：冻结版本化数据集；确定性安全 case 必须全过；质量/成本/延迟设置绝对下限和相对基线；按关键切片判定；保存失败 Trace 和 diff；模型抖动用重复运行；通过后再 shadow/canary。

### Q68. 如何做线上 Trace Replay？

- **想听**：保存脱敏输入、工具结果引用、版本和随机参数；区分 pure replay（复用旧工具结果）与 live replay（重新调用依赖）；默认禁止副作用工具，重放必须进入隔离环境并重新授权。

### Q69. 给你两周提升本项目评估与可观测性，怎么排优先级？

- **推荐答案**：第一周把本地 Trace 提升到请求边界 AgentRun，增加 canonical runId、终态/error schema、release descriptor 和持久化完整性指标；同时补 `/api/chat` 生产路径 Eval harness。第二周扩 Agent/Memory golden set、建立安全与质量门禁、补 metrics/SLO/告警，并把失败 Trace 回流 Dataset。

### Q70. 成熟 Agent 质量体系的最终闭环是什么？

- **想听**：版本化发布 -> 离线门禁 -> shadow/canary -> 线上 Trace/Metrics/Feedback -> 异常 cohort -> 人工标注 -> Dataset/Eval 回流 -> 修复与回滚。可观测性提供证据，评估把证据变成决策。

---

## 项目证据索引

| 能力 | 当前代码/Schema | 面试表达 |
|---|---|---|
| 请求根观测 | `app/api/chat/route.ts` | Langfuse 根 observation 覆盖路由、记忆和执行，但本地 Trace 仍从执行器创建 |
| 本地 Trace 类型 | `lib/agent/runtime/trace.ts` | 判别联合的平铺步骤 + 聚合 metrics，尚非 span tree |
| Runtime 埋点 | `lib/agent/runtime/index.ts` | model/tool/compaction/retrieval 和预算、token、成本、停止原因 |
| Planning Trace | `lib/agent/runtime/plan-execution.ts` | plan created/executed/verified，子循环步骤重编号合并 |
| Trace 持久化 | `lib/agent/runtime/trace-store.ts` | Supabase JSONB、脱敏、保留期兼容；缺 canonical run/OTel 字段 |
| Trace 查询 | `app/api/traces/`、`app/traces/` | 用户隔离的列表/详情/删除和可视化 |
| OTel/Langfuse | `instrumentation.ts` | NodeSDK + LangfuseSpanProcessor，生产资源/采样/生命周期待完善 |
| 通用 Eval | `lib/agent/eval/datasets/agent.ts`、`runner.ts` | 3 条 live case，执行边界是 `runAgentLoop` |
| Mock/Live 双轨 | `lib/agent/eval/run-eval.test.ts` | 默认 1 条 mock；live 需 `EVAL_LIVE=1` |
| Dataset Run | `scripts/langfuse-eval.ts` | 同步 Agent/routing cases，记录 executionBoundary |
| 在线评分 | `lib/agent/eval/online-scores.ts` | 完成、工具错误、调用数、延迟与 RAG groundedness/citation |
| RAG Eval | `scripts/rag-eval.ts`、`rag-groundedness-eval.ts` | 检索、路由和证据支撑专项，与通用 Agent Eval 分开 |
| 记忆观测 | `app/api/chat/route.ts`、`lib/agent/memory/observability.ts` | 聚合 recall/consolidate/forget，不记录记忆正文 |
| 记忆测试 | `lib/agent/memory/*.test.ts` | 策略与存储覆盖，尚缺独立 memory golden set 和生产门禁 |

---

## 备考策略

### 初级岗位

优先掌握 Q1-Q8、Q19-Q24、Q39-Q43，能区分 Trace、Metric、Eval，并讲清 mock/live。

### 中高级岗位

重点准备 Q9-Q18、Q25-Q38、Q47-Q62，能从一次 Run 讲到记忆专项评估、错误分类、版本和治理。

### Senior / Staff

重点准备 Q44-Q54、Q63-Q70，回答必须包含 SLO、门禁、数据闭环、故障窗口和组织级责任边界。

---

## 一句话复习版

1. 可观测性回答“发生了什么和为什么”，评估回答“这个版本是否足够好”。
2. Trace、Log、Metric、Eval、Online Score 互补，任何一个都不能单独构成质量体系。
3. Agent 要按路由、计划、工具、检索、记忆、生成、安全和成本分层评估。
4. 当前项目已有执行器级本地 Trace 和请求级 Langfuse 根观测，但尚未统一成 canonical AgentRun。
5. 默认 mock Eval 验证协议，live Eval 验证模型行为，`/api/chat` 生产路径仍需独立 harness。
6. 在线 Score 是漂移信号，不是人工标准答案。
7. 记忆评估必须覆盖抽取、决策、召回、使用和遗忘，不能只看向量命中。
8. 失败、取消和降级必须有结构化终态；最需要 Trace 的路径不能最容易丢 Trace。
9. ReleaseDescriptor 是回放、归因、对比和回滚的前提。
10. 最终闭环是“离线门禁 -> 灰度 -> 线上观测 -> 失败回流 -> 再评估”。
