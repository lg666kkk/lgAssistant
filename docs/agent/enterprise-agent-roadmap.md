# 企业级 Agent 路线图（2026-07 整合版 · 当前主文档）

> 本文是唯一的 Agent 建设主路线图，已整合早期成熟度对标、架构蓝图和平台评估。
> 历史版本不再留在 `docs`，需要时从 Git 追溯。
> 本文以 file:line 锚点和条目级验收回答「下一步改哪个文件」。
> 新增企业级条目用 E 系列编号。成本口径：S（半天）/ M（1-2 天）/ L（3 天+）。

---

## 0. 现状校准

### 0.1 已落地的能力（不再出现在本路线图）

| 旧编号 | 条目 | 现状证据 |
|---|---|---|
| C1 | LLM 摘要式 compaction | `compaction.ts` 语义压缩（固定小节结构化摘要）+ 确定性回退，`index.ts:459` `compactLoopMessagesSemantic` |
| C3（部分） | 真实 usage 记账 | `index.ts:1190` 优先模型 usage、缺失回落估算，cache hit/miss 分档计费（`models.ts`） |
| C4 | Prompt 分层组装 | `lib/agent/prompt/`（pipe/segments/budget/policies/render），systemSegments 透传 trace |
| C5（部分） | 上下文可解释 | ModelTraceStep 记录注入的 system prompt + systemSegments（`trace.ts:29-42`） |
| H4 | 工具并发 | `index.ts:759` executeToolUsesWithScheduler：只读并行分组 + 写操作串行 + 同批去重 |
| ❌→✅ | Planning | 已实现 Plan-and-Execute + 人工审批（`plan-execution.ts`），含受限工具集/分步校验/续跑 |
| — | Langfuse 双层可观测 | `route.ts:265` startActiveObservation + propagateAttributes |
| — | HITL | plan_proposal 审批、`ask_user` 工具、工具级 confirm（`tool-router.ts:92`） |

### 0.2 已验证的高危问题（2026-07-16 逐条核实，进 P0）

| 问题 | 证据 | 严重度 |
|---|---|---|
| 工具确认接口 = 任意工具执行接口 | [confirm/route.ts](../../app/api/tools/confirm/route.ts) 直接接收客户端 `toolCall.name + input`，带 `approved: true` 执行——「确认」是客户端自我声明，登录用户可绕过风险分级执行任何工具 | **最高** |
| cron 鉴权可伪造 | 已由 `lib/scheduler/cron-auth.ts` 统一改为 Bearer/x-cron-secret 严格校验，伪造 UA 不再放行 | 已修复 |
| webhook SSRF | `scheduler/handlers/` reminder 向用户提供的 webhook 地址发请求，无内网/metadata endpoint 防护 | 高 |

### 0.3 当前系统一句话定位

**能力骨架已接近成熟**（上下文三层防爆、规划、记忆雏形、可观测、双轨 eval 都有了）。综合成熟度约 **2/5：能力完整的单用户原型**。企业级的差距不在再加 AI 能力，而在：

1. 强制性安全边界（服务端审批、RLS、注入防护、审计）
2. 可靠性语义（at-least-once、可恢复执行）
3. 成本治理（租户级配额熔断）
4. 质量回归闭环（eval 门禁、replay、版本化归因）

主线不是「让 Agent 更聪明」，而是让它在多人、长时间、真实副作用场景下**可控、可恢复、可审计、可运营**。

---

## 1. 目标架构

```text
Web / API Client
      |
      v
API Gateway: AuthN · 租户上下文 · 配额 · requestId
      |
      +----------------------> Control Plane
      |                        策略 / 模型配置 / 版本 / eval / 发布 / 审计
      v
Agent Run Service（create / approve / cancel / resume / query）
      |
      v
Durable Queue ---> Agent Workers ---> Model Gateway（多供应商/熔断/降级）
                       |  |
                       |  +---------> Tool Gateway（策略/审批/幂等/审计）
                       +------------> Context Services（RAG / Memory / Artifacts）
      |
      v
Event Store + Run Checkpoints + Trace + Metrics + Audit Log
```

核心原则（来自平台版，全文最重要的六句话）：

1. API 请求只负责创建或控制任务，worker 负责执行任务；
2. `AgentRun` 是唯一运行事实来源，SSE 只是事件的实时投影；
3. 所有副作用都经过策略、审批、幂等和审计；
4. **模型输出不直接获得权限，权限来自服务端策略**；
5. 授权、审批、计费用确定性规则，不用模型判断替代；
6. 每次线上行为都能关联到模型、Prompt、工具和策略版本。

---

## 2. 路线图总览（六阶段）

| 阶段 | 主题 | 一句话目标 | 建议周期 |
|---|---|---|---|
| **P0** | **封堵生产阻断项** | 已验证漏洞立即修，先于一切 | 2-4 天 |
| P1 | 不丢事、不泄露 | 正确性与安全底座 | 1-2 周 |
| P2 | 记忆可信 | 记忆生命周期管理（平台版丢弃了此项，本文保留，理由见 §5） | 2-3 周 |
| P3 | 改动可回归 | 质量保障闭环，敢持续迭代 | 2-3 周 |
| P4 | 可恢复执行与规模 | AgentRun 状态机 + worker + 配额 + 模型网关 | 3-5 周 |
| P5 | 平台化 | 租户/RBAC、MCP、治理 UI、合规 | 按需 |

依赖关系：

```text
P0 ──> P1 ──> P2 ──┐
        │          ├──> P3 ──> P4 ──> P5
        └──────────┘
（P2 与 P3 可部分并行；P4 的 AgentRun 依赖 P1 的调度可靠性）
```

---

## 3. P0 封堵生产阻断项（立即做，先于一切）

### E0.1 工具审批改服务端绑定 — M / 最高优先级

- **缺口**：[confirm/route.ts](../../app/api/tools/confirm/route.ts) 接收客户端传来的完整 `toolCall` 并以 `approved: true` 执行。任何登录用户可构造请求执行任意工具、任意参数，`riskLevel` 分级形同虚设。
- **改法**：
  1. loop 内工具返回 `pending_confirmation` 时（`tool-router.ts:92`），服务端把 pending 调用落库：`pending_actions(id, user_id, session_id, tool_name, input_hash, input_ref, risk, expires_at, status)`；
  2. 前端只拿到 `pendingActionId`，确认时仅提交这个 id（一次性 approval token）；
  3. 服务端校验：属于该用户 + 未过期 + 未消费 + 重新从库里取原始 input 执行（**不信任客户端回传的参数**）；执行后标记 consumed，防重放；
  4. 拒绝/超时的 pending 记入审计。
- **验收**：直接 POST 任意 toolCall 到 confirm 接口返回 4xx；修改工具名或参数后复用 approval id 失败；同一 id 第二次提交失败。

### E0.2 cron 鉴权去掉 UA 信任 — S / 高

- **状态**：已完成。`tick` 和 `rag-ingestion` 共用 `lib/scheduler/cron-auth.ts`，删除 UA 与 query-string secret 分支；配置 secret 后只有 Bearer 或 `x-cron-secret` 匹配才放行。
- **验收**：伪造 UA、错误 secret、开发 header 绕过均有单元测试；生产环境未配置 secret 时所有 cron 请求返回 403。

### E0.3 webhook / 外发请求统一 SSRF 防护 — S~M / 高

- **缺口**：reminder handler 向用户提供的 webhook 地址直接发请求；`lib/agent/tools/web-fetch.ts` 的 SSRF 防护未覆盖 scheduler 出口。
- **改法**：抽公共 `safeOutboundFetch`：协议白名单（https）、DNS 解析后校验 IP 非 loopback/私网/link-local/metadata 段、重定向后复检、超时与响应大小上限；webhook 与 web_fetch 共用。
- **验收**：webhook 指向 `127.0.0.1`、`10.x`、`169.254.169.254` 均被拒绝并记录。

---

## 4. P1 不丢事、不泄露（正确性与安全底座）

### E1 调度器改「至少一次」语义 — M / 高

- **缺口**：`store.ts:90` ZRANGEBYSCORE 取到期后立即 ZREM（出队即删）。handler 执行到一半进程崩溃，任务永久丢失——当前是「至多一次」，且领取非原子。
- **改法**：
  1. 领取改为**原子 claim**（Lua 脚本或 `ZPOPMIN`+processing ZSet）：移入 processing（score=lease 到期时间）而非直接删；
  2. handler 成功后 ack（从 processing 删除）；长任务可心跳续 lease；
  3. tick 开头扫 processing 中 lease 过期的任务重新入队，重试计数 +1；
  4. 超过 N 次进死信（`scheduled_jobs.status='dead'` + 告警），提供 DLQ 查看/重放/终止能力。
- **配套**：handler 幂等化——`agent-task` 以 `jobId+runAt` 做执行记录去重；`reminder` 推送带幂等键。
- **涉及**：`lib/scheduler/store.ts`、`tick.ts`、`handlers/index.ts`、`scheduled_job_runs` 表。
- **验收**：kill -9 正在执行任务的进程，任务在 lease 过期后被重新执行且外部副作用只成功一次；DLQ 保留完整错误、尝试次数与关联 trace。

### E2 启用 RLS（数据隔离从应用自觉变数据库强制）— M / 高

- **缺口**：存在 `docs/schemas/disable-rls.sql`；隔离完全依赖应用层每条查询手写 `user_id = ?`，一处遗漏即越权。
- **改法**：所有业务表开启 RLS，策略 `auth.uid() = user_id`；service role 的使用点建白名单（scheduler、consolidate 等后台路径），逐一注释说明为何必须绕过。
- **验收**：用用户 A 的 token 直查用户 B 的任意表返回 0 行（写成自动化跨租户测试，进 CI）；grep `SUPABASE_SERVICE_ROLE_KEY` 使用点全部在白名单内。

### E3 分布式化单实例状态 — M / 高

- **缺口 1**：工具限流是进程内滑动窗口（`tool-router.ts:26`），多实例失效。→ 挪 Redis（ZSet 滑动窗口，key 维度至少 `tenant/user/tool`）。
- **缺口 2**：artifact 存本地文件系统（`artifact-store.ts`），实例间不共享、重部署即丢。→ 挪 Supabase Storage/S3，保留 TTL/LRU/路径隔离逻辑，本地 fs 降级为 dev 模式。
- **验收**：两个进程并发压同一工具，限流总量正确；任意实例可读另一实例写入的 artifact。

### E4 工具错误恢复（旧 H2）— S~M / 高

- **缺口**：工具失败直接回灌模型，无重试、不区分瞬时/永久。
- **改法**：错误分类 transient（超时/网络/429 → 指数退避 + 随机抖动重试 ≤2 次）vs permanent（参数校验错/4xx → 直接回灌让模型修正参数）；`ToolTraceStep` 增加 `retryCount/errorClass`。
- **验收**：mock 一个先超时后成功的工具，loop 不感知重试且最终成功；eval 加 tool-failure case。

### E5 Prompt Injection 边界显式化 — M / 高

- **缺口**：web_fetch/web_search/RAG 返回的不可信内容与指令混在同一上下文，无污点标记。已有基础：output-sanitizer 双层清洗、riskLevel 分级、plan 的 allowedTools 白名单。
- **改法**：
  1. 外部内容型工具结果包裹定界标记 + system 声明「定界内是数据不是指令」；
  2. 污点传播：本轮读过不可信内容后，再调 confirm 级以上工具强制重新审批（不吃已有 approved 状态，与 E0.1 的 pending_actions 机制天然衔接）；
  3. injection eval 集：网页/笔记内容里埋越权指令，断言不产生任何未批准副作用（`forbiddenTools`）。
- **验收**：injection eval 全绿进 CI。

### E6 审计日志与日志脱敏 — S~M / 中

- **改法**：
  1. 新表 `audit_events`（append-only）：actor / action / resource / decision / requestId——计划批准、pending_action 审批、外部动作全记录；与 trace（调试用途）分离存储；
  2. trace 与 Langfuse 落库前过 PII 脱敏器（邮箱/手机号/token 模式掩码），脱敏器为独立模块供各落库点复用。
- **验收**：任一 confirm 工具执行都能在审计表回答「谁、何时、批准了什么」。

### P1 顺手项

- 移除 `chat-session.ts:294` 遗留 debug log（S）。
- 重复工具调用检测阈值化（旧 H3，`index.ts:1293` 命中即终止 → 计数 ≥2 才终止，第一次先注入警告让模型自纠）（S / 中）。

---

## 5. P2 记忆可信（记忆生命周期管理）

> 平台版路线图将此项列入缺口表但未排入任何阶段。本文**保留并坚持其优先级**，理由：错误记忆污染是「一条错误反复影响所有后续回答」的复利型风险，且记忆可信是记忆治理 UI（P5·M6）和 memory eval（P3·H1）的前置。旧编号 M1/M2/M4/M5 沿用，按落地依赖排序。

### M4 Schema 升级（先做，M1/M3 的数据基础）— M / 中

`MemoryRecord` 增加：`type`(preference/fact/profile/project/correction/episodic)、`source`(user_explicit/inferred/tool)、`confidence`、`status`(active/invalidated/conflicted)、`valid_from/valid_to`、`last_accessed_at`、`evidence`(requestId+excerpt)。
涉及：`memory/types.ts`、两个 store、`memories-schema.sql`、`semantic-memories-schema.sql` 迁移。

### M1 写入管线：抽取与更新分离（MemoryWriteDecision）— M / 高

- **缺口**：`memory-flow.ts:103` consolidate 抽取后按 key 直接 upsert，事实演化时新旧并存或静默覆盖。
- **改法**：抽取每条 fact 后先 `semantic.recall(fact, 5)` 召回相似旧记忆，把「新 fact + 候选旧记忆(带 id)」喂决策 prompt，返回 `{action: ADD|UPDATE|DELETE|NOOP, targetId?, reason, confidence}`，分支执行；决策记入 trace（新增 MemoryTraceStep）。
- **写入门槛**（policy 落地，配 M4 字段）：用户明确说的 > 模型推断；低置信不写；敏感信息（健康/财务/证件模式）默认不自动写；一次性任务不写长期。

### M2 软失效替代硬删 — M / 高

DELETE 决策改为 `status='invalidated', valid_to=now()`；召回默认只查 active。保留「某时刻为真」的可追溯性（对标 Zep bi-temporal）。

### M3 召回三因子重排 — M / 中

recall 放宽到 20-30 候选，按 `score = w_r·relevance + w_i·importance + w_t·recency(指数衰减)` 重排取 top-k；重排异常 fail-open 回退余弦序；命中记忆回写 `last_accessed_at`。

### M5 consolidate 输入改完整轮次 — S / 中

当前只传本轮消息，改传 `loopMessages` 全量（含工具结果语境），`memory-flow` 侧零改动。

### P2 验收

- eval 新增 memory-write case：「我对香菜过敏」→ ADD；「其实我不过敏了」→ UPDATE/invalidate 旧记忆而非并存；「帮我算 3+5」→ NOOP。
- 同一事实连说三轮，库里只有一条 active 记录。

---

## 6. P3 改动可回归（质量保障闭环）

### H1 Eval 扩容 + 三层断言 + LLM-as-judge — M / 高

- **改法**：
  1. mock 轨进 CI 作为 merge gate（现有 `npm run test:eval`）；
  2. 数据集扩到 30+ 条，覆盖 `tool-routing / plan / rag / memory-recall / memory-write / context-budget / abort / tool-failure / safety(injection·跨租户·approval-replay) / regression`；
  3. **断言三层**：确定性（工具名/轮数/stopReason/是否写记忆）→ 轨迹（trace step 顺序/context item 存在性）→ LLM-as-judge（回答质量/faithfulness，judge 直接吃 `trace.steps` 结构化对象，rubric + judge model 版本钉进 git，跑 nightly 非 CI）。

### H5 Replay Harness — L / 高

- **改法**：`lib/agent/harness/{replay,diff,report}.ts`——从 `agent_traces` 取线上 trace → 还原输入 + mock 当时的工具结果 → 用新配置重跑 → diff 两份 trace（工具序列/token/latency/记忆写入/最终回答）→ 输出报告。
- **价值**：改 prompt 前先对最近 N 条线上 trace 跑 replay，退化可见后才上线。

### E7 版本化与发布归因 — S~M / 高（较上版升级）

- Prompt 段、记忆写入 policy、工具 schema、模型配置各自生成**不可变版本**（内容 hash），组合为 `release_version`（一组 hash 的快照）写入每条 trace。
- **没有版本归因，出问题无法定位到哪次改动**；这也是 A/B、灰度与一键回滚（P5·E14）的前置。
- 每次发布至少满足（发布门槛 checklist，来自平台版）：单元/集成测试过；跨租户、approval replay、SSRF、injection 测试过；核心 eval 相对基线无超阈值退化；迁移有前滚/回滚方案。

### E8 失败样本自动回流 — M / 中

`stopReason` 异常（repeated_tool_call/max_iterations/budget_exceeded）或用户点踩的 trace，自动生成 eval case 草稿（进待审核队列，人工确认后入库）。数据飞轮。

### P3 验收

- CI：mock 轨 + injection 轨 + 跨租户轨全绿才可 merge。
- 演示：改一版 system prompt → replay 最近 20 条 trace → 报告显示行为 diff → trace 可反查 release_version。

---

## 7. P4 可恢复执行与规模（从工具到服务）

### E9 AgentRun 持久化状态机 + worker 化 — L / 高（方案采用平台版设计，替换旧渐进式方案）

- **缺口**：agent loop 跑在 SSE 请求生命周期内，受 serverless 超时硬限制，用户关页面任务即死；ReAct / Plan-and-Execute / `ask_user` / 计划审阅 / 工具确认五种暂停恢复逻辑各自为政。
- **目标状态机**（统一所有执行模式与 HITL 场景）：

```text
queued -> running -> waiting_for_user -> running
                  -> retrying         -> running
                  -> paused           -> running
                  -> succeeded | failed | cancelled | expired
```

- **改法**：
  1. 新表：`agent_runs`（status/mode/version_set/budget/lease）、`agent_run_steps`（type/status/attempt/input_ref/output_ref）、`agent_run_events`（sequence/type/payload，可重放事件流）、`agent_run_checkpoints`（iteration/state_ref/token_state）；
  2. **`AgentRun` 是唯一运行事实来源**：ReAct 与 Plan-and-Execute 共用同一生命周期；`ask_user`、计划审阅、E0.1 的 pending_actions 统一映射为 `waiting_for_user`；
  3. API 请求只做「创建 run 入队 + 返回 runId」，worker（先由 scheduler 的 `agent-task` 承载，依赖 P1·E1 的可靠队列）执行 loop；run 领取带 lease，保证**同一 run 不被两个 worker 同时执行**；
  4. 每个模型轮次和工具步骤结束写 checkpoint（`loopMessages + tokenBudget + iteration` 快照，大对象存 artifact 引用）——plan-execution 的 `startAtStep/priorStepResults` 已是半成品，推广到主 loop；
  5. **SSE 降级为事件投影**：从 `agent_run_events` 读取，断线后按 event cursor（sequence）补发，不丢不重；
  6. 提供 create / get / cancel / resume / approve API；明确终止原因、错误分类与可重试性。
- **大字段原则**：工具原始输出、checkpoint 状态存对象存储，数据库只存引用 + hash + 大小 + 保留期。
- **验收**：浏览器关闭后任务继续执行；SSE 断线重连不丢不重；worker 被杀后从最近 checkpoint 恢复；cancel 最终停止模型流与未开始工具；并发领取同一 run 只有一个 worker 成功。

### E17 模型网关（多供应商/熔断/降级）— M / 中（新增，来自平台版）

- **缺口**：`model-provider.ts` 单一 DeepSeek 供应商，无故障切换。
- **改法**：在现有 provider 抽象上加：供应商级超时/重试/熔断（连续失败 N 次跳闸走备用）、按策略降级（主模型故障 → 备用模型 + trace 记录原因 + Langfuse WARNING）、模型配置进 E7 版本体系。
- **验收**：mock 主供应商 5xx，请求自动降级完成并在 trace 标注。

### E10 租户级成本治理 — M / 高

- Redis 计数器维护 per-user 日/月 token 与费用累计；请求前检查配额，超限降级 flash 模型或拒绝（明确错误事件）；80% 阈值告警。
- 配套：模型路由策略化（按任务类型/用户等级/预算余量选模型），与 E17 网关合并实现。

### E11 Ops 指标、SLO 与告警 — M / 中

`lib/agent/ops/{metrics,health}.ts` + `/api/health`。指标：成功率 / p95 latency / 排队时间 / 首事件延迟 / tool error rate / repeated call rate / budget exceeded rate / 记忆召回命中率 / RAG no-result rate / **降级率**（压缩回退、fallback plan、keyword RPC 缺失、模型降级——全打 Langfuse WARNING）/ 成本每请求。

**SLO 初始目标**（来自平台版，作为 P4 完成后的北极星，非当期硬指标）：

| 指标 | 目标 |
|---|---|
| 已接受 Run 永久丢失率 | < 0.01% |
| 可重试故障恢复率 | >= 99% |
| 未授权跨租户访问 / 未经审批的高风险副作用 | 0 |
| Trace 与审计关联率 / 费用归属覆盖率 | 100% |
| 首事件延迟 p95 | < 2 秒 |

告警：tool error rate 连升、budget exceeded 突增、降级率异常、DLQ 非空。

---

## 8. P5 平台化（生态与合规，按需启动）

| # | 条目 | 说明 | 成本 |
|---|---|---|---|
| E18 | 租户模型与 RBAC | `organizations / workspaces / memberships(role)` 三表 + owner/admin/builder/operator/viewer 角色；RLS 策略升级为 workspace 维度；RAG 检索与记忆召回继承 workspace ACL；外部凭据进 secrets vault 按 workspace 隔离。**单人使用阶段不做**，出现第二个真实用户/团队场景再启动 | L |
| E12 | MCP 工具接入 | 工具从「代码内注册」扩展为 MCP client 标准协议接入，registry 加适配层；接入 checklist 必含注入评估（E5） | L |
| M6 | 记忆治理 UI + API | GET/PATCH/DELETE `/api/memory`、「别记这件事」开关、记忆溯源（evidence 展示） | L |
| E13 | 数据合规 | 用户数据导出；删除级联补全 Redis/artifact/Langfuse 侧（DB 已有 CASCADE）；trace/audit 保留期策略；删除流程覆盖 RAG、记忆、artifact、备份 | M |
| E14 | A/B 与灰度 | 基于 E7 版本化：按用户桶分流 prompt/模型配置，指标对比（依赖 E11）；支持一键回滚 | M |
| E19 | 管理员控制台 | run / 审批 / DLQ / 配额 / 策略 / 版本 / 审计 的统一视图（P4 各能力的 UI 收口） | L |
| E15 | RAG 精排升级 | 规则重排 → 交叉编码器/LLM rerank（规则版保留为降级路径）；可选引用行级溯源 | M |
| E16 | 多 Agent / 子任务委派 | **启动条件（来自平台版，采纳）：至少存在两个真实场景证明单 Agent + Plan-and-Execute 无法在可接受成本和可靠性下完成**，否则不做 | — |

---

## 9. 里程碑与验收总表

| 里程碑 | 核心交付 | 硬验收 |
|---|---|---|
| **P0（2-4 天）** | E0.1 审批服务端绑定 · E0.2 cron 鉴权 · E0.3 SSRF | 伪造 confirm/cron 请求全部 4xx；webhook 打不到内网 |
| P1（1-2 周） | E1 at-least-once+DLQ · E2 RLS · E3 分布式限流+artifact · E4 错误恢复 · E5 注入边界 · E6 审计 | kill 进程任务不丢且副作用只成功一次；跨用户查询 0 行；injection eval 绿 |
| P2（2-3 周） | M4 schema · M1 写入决策 · M2 软失效 · M3 三因子 · M5 全量输入 | 事实演化只剩一条 active；memory eval 绿 |
| P3（2-3 周） | H1 三层断言+judge · H5 replay · E7 版本化+发布门槛 · E8 失败回流 | CI 门禁生效；prompt 改动可 replay 出 diff 并反查版本 |
| P4（3-5 周） | E9 AgentRun+worker+checkpoint · E17 模型网关 · E10 配额 · E11 ops/SLO | 关浏览器任务继续；断点续跑；SSE 断线补发；超配额自动降级 |
| P5（按需） | E18 RBAC · E12 MCP · M6 记忆 UI · E13 合规 · E14 A/B · E19 控制台 | 按条目 |

---

## 10. 风险清单

1. **审批绕过已存在**（P0 前最高风险）：confirm 接口可执行任意工具（→ E0.1）。
2. **调度丢任务**：at-most-once + handler 无幂等（→ E1）。
3. **应用层隔离单点**：一处漏写 user_id 过滤即越权（→ E2）。
4. **错误记忆污染**：无冲突决策，一条错记忆复利式影响回答（→ M1/M2）。
5. **改动不可归因**：prompt 无版本，质量退化无法定位（→ E7/H5）。
6. **注入攻击面随工具增长**：每加一个外部内容工具攻击面 +1（→ E5，新工具 checklist 必含注入评估）。
7. **serverless 超时截断长任务**：loop 与请求生命周期耦合（→ E9）。
8. **成本失控**：无配额，异常用户/循环 bug 烧穿预算（→ E10；短期靠 maxToolIterations + TokenBudget 兜底）。
9. **单点依赖故障**：模型/Redis/worker/外部工具任一故障时行为需可预测（→ E17/E1/E4，降级必须在 trace 可见）。

---

## 11. 明确非目标（来自平台版，采纳）

以下内容不应早于 P0-P4 启动：

- 为展示效果引入多 Agent（启动条件见 E16）；
- 自研通用工作流 DSL；
- 同时支持大量模型供应商（E17 只要求主备两家）；
- 在权限和数据治理前建设工具 marketplace；
- **用模型判断替代确定性的授权、审批和计费规则**；
- 没有真实负载前做跨区域多活。

---

## 12. 企业级完成定义（来自平台版，采纳）

当以下问题都能用**系统证据**回答时，才可以称为企业级 Agent：

1. 一个任务失败后，系统能否恢复、重试、跳过、取消或人工接管？（E9/E1）
2. 每个副作用是否可证明经过授权、审批、幂等和审计？（E0.1/E6/E1）
3. 任意两个用户的数据是否在数据库、检索、记忆和 artifact 层都隔离？（E2/E18）
4. 一次异常回答能否定位到输入、模型、Prompt、工具、策略和代码版本？（E7 + trace）
5. 变更上线前是否有 Eval 证据，上线后是否能灰度和回滚？（H1/H5/E14）
6. 单一模型、Redis、worker 或外部工具故障时，系统行为是否可预测？（E17/E1/E4）
7. 用户能否控制自己的记忆、数据、预算和保留策略？（M6/E13/E10）
8. 成本、质量、安全和可靠性是否都有明确 SLO 与 owner？（E11）

---

## 13. 面试视角速记

- **安全**：「我在自己项目里做安全审计时发现了一个审批绕过漏洞——确认接口信任客户端回传的工具调用参数。修法是服务端保存 pending action、客户端只提交一次性 token、执行时从库里取原始参数。这让我真正理解了『模型输出和客户端输入都不直接获得权限，权限来自服务端策略』。」
- **可靠性语义**：「调度从 at-most-once 改 at-least-once：出队即删在 crash 时丢任务，改成原子 claim + lease + ack + 死信队列，handler 幂等化保证副作用只成功一次。」
- **可恢复执行**：「把 ReAct、计划审阅、ask_user、工具审批五种暂停统一成 AgentRun 状态机的 waiting_for_user 状态；SSE 只是持久事件流的投影，断线按 cursor 补发；每轮写 checkpoint，worker 被杀从断点续跑。」
- **数据隔离**：「隔离不能靠应用层自觉，RLS 让越权在数据库层被强制拦截，service role 使用点白名单化。」
- **质量闭环**：「prompt/模型/工具/策略各自内容 hash 组成 release_version 进 trace；改动先对线上 trace replay 看行为 diff；线上失败样本自动回流成 eval case。」
- **成本**：「单请求 TokenBudget 之上加用户级日/月配额，超限自动降级便宜模型；cache hit/miss 分档记账数据已有，治理是消费侧闭环。」
- **为什么不先做多 Agent**：「企业级差距在可靠性/安全/回归这些地基；多 Agent 有明确启动条件——两个真实场景证明单 Agent 做不到，否则是负优化。」
