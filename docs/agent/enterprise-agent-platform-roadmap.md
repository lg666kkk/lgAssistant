# 企业级 Agent 平台路线图（独立评估版）

> ⚠️ **2026-07-16 已整合**：本文核心内容（P0 安全阻断项、AgentRun 状态机、模型网关、SLO、非目标、完成定义）已整合进 [enterprise-agent-roadmap.md](./enterprise-agent-roadmap.md)（当前执行主文档），原文保留作为系统级视角依据。
> 整合时的差异处理：本文缺口表中的记忆生命周期（冲突决策/软失效）未排入任何阶段，主文档保留为 P2；缺口表中 RAG 代码边界 `lib/rag/` 应为 `lib/knowledge/`。

> 评估日期：2026-07-15  
> 评估范围：当前仓库的运行时代码、API、存储、调度、工具、RAG、记忆、Trace 与 Eval。  
> 本文不继承项目中已有路线图的阶段、编号或结论，而是从当前代码边界重新推导建设顺序。

## 1. 结论

当前项目已经不是简单的聊天应用，也不是纯 ReAct Demo。它已经具备一个 Agent 产品原型所需的大部分能力骨架：

- ReAct 工具循环与结构化工具协议；
- Plan-and-Execute、计划审阅、失败重试与跳过；
- `ask_user` 人机交互与高风险工具确认；
- RAG、分层记忆、上下文预算与压缩；
- Trace、SSE 事件、基础 Eval 和定时任务；
- 工具风险等级、限流、输出清洗和 artifact 存储。

但它距离企业级系统的主要差距，不是再增加一种 Agent 范式，而是补齐以下平台能力：

1. **可恢复执行**：任务不能依赖单个 HTTP/SSE 请求存活。
2. **强制安全边界**：身份、租户、授权和审批必须由服务端可信状态决定。
3. **可靠基础设施**：队列、调度、限流、artifact 和幂等需要支持多实例。
4. **质量发布体系**：Prompt、模型、工具和策略的变更必须可评估、可灰度、可回滚。
5. **运营与合规**：成本、SLO、审计、数据保留和删除必须可以治理。

综合判断：当前成熟度约为 **2/5，能力完整的单用户原型**。完成 P0-P3 后可达到 **3.5/5，可供团队和早期企业客户使用**；完成 P4-P5 后才接近 **4/5，具备企业级平台基础**。

## 2. 当前能力与关键缺口

| 领域 | 当前能力 | 企业级缺口 | 代码边界 |
|---|---|---|---|
| Agent Runtime | ReAct loop、Plan-and-Execute、流式事件 | 执行依赖请求生命周期，缺少统一持久化状态机 | `app/api/chat/route.ts`、`lib/agent/runtime/` |
| Human-in-the-loop | 计划审阅、`ask_user`、工具确认 | 审批凭据和待执行调用需要服务端绑定与防重放 | `app/api/tools/confirm/route.ts`、`lib/agent/tools/ask-user.ts` |
| Tool Governance | registry、风险等级、进程内限流 | 分布式限流、策略引擎、凭据隔离、幂等键 | `lib/agent/tools/tool-router.ts` |
| Scheduler | Redis 到期任务、Agent task handler | 非原子领取、缺 lease/ack/DLQ，webhook 缺 SSRF 边界 | `lib/scheduler/store.ts`、`lib/scheduler/handlers/` |
| RAG | 文档检索与上下文注入 | 权限感知检索、引用证据、离线质量集、数据生命周期 | `lib/rag/`、`app/api/` |
| Memory | 多层记忆、召回与 consolidation | 冲突更新、来源证据、软失效、用户治理 | `lib/agent/memory/` |
| Storage | Supabase + 本地 artifact | service role 使用面偏大，本地 artifact 不支持多实例 | `lib/platform/supabase.ts`、`lib/agent/runtime/artifact-store.ts` |
| Model | 单一 DeepSeek provider | 多供应商路由、熔断、降级、配置版本化 | `lib/agent/runtime/model-provider.ts` |
| Observability | Trace、Langfuse、运行指标雏形 | SLO、告警、审计日志、PII 脱敏、跨服务关联 | `lib/agent/runtime/trace.ts` |
| Evaluation | 少量确定性 case | 场景覆盖不足，缺 replay、judge、发布门禁 | `lib/agent/eval/cases.ts` |
| Tenancy | 业务查询中携带用户信息 | 缺组织/工作区/RBAC，数据库隔离策略需系统化 | `lib/platform/supabase.ts` |

## 3. 目标架构

```text
Web / Desktop / API Client
          |
          v
API Gateway: AuthN, tenant context, quota, request id
          |
          +---------------------> Control Plane
          |                       org / workspace / RBAC
          |                       policy / model config / secrets
          |                       eval / release / audit / billing
          v
Agent Run Service
  create run / approve / cancel / resume / query
          |
          v
Durable Queue  --->  Agent Workers  --->  Model Gateway
                         |   |
                         |   +----------> Tool Gateway
                         |                 policy / approval / idempotency
                         |
                         +--------------> Context Services
                                           RAG / memory / artifacts
          |
          v
Event Store + Run Checkpoints + Trace + Metrics + Audit Log
```

核心原则：

- API 请求只负责创建或控制任务，worker 负责执行任务；
- `AgentRun` 是唯一运行事实来源，SSE 只是事件的实时投影；
- 所有资源都带 `organization_id` 和 `workspace_id`；
- 所有副作用都经过策略、审批、幂等和审计；
- 模型输出不直接获得权限，权限来自服务端策略；
- 每次线上行为都能关联到模型、Prompt、工具和策略版本。

## 4. 建设阶段

### P0：封堵生产阻断项（1-2 周）

目标：先消除会导致越权、任务丢失和内网访问的高风险问题。

交付：

- 为 cron 使用签名密钥或平台身份校验，不再信任 `User-Agent`；
- webhook 与网页抓取统一接入 SSRF 防护：协议白名单、DNS/IP 检查、重定向复检、超时和响应大小限制；
- 工具确认改为服务端保存 `pending_tool_call`，客户端只提交一次性 approval token；
- approval token 绑定 user、workspace、run、tool、参数 hash、过期时间并防重放；
- 对 service role 调用点建立白名单，所有业务查询显式携带租户条件；
- 建立敏感字段脱敏器，覆盖 Trace、日志和外部可观测平台；
- 为外部内容增加不可信数据标记，进入高风险工具前重新审批。

验收：

- 伪造 cron 请求返回 401/403；
- webhook 无法访问 loopback、私网、metadata endpoint；
- 修改工具名或参数后复用 approval token 必须失败；
- 用户 A 无法读取、审批或取消用户 B 的 run；
- injection eval 不产生任何未批准的副作用。

### P1：统一持久化 AgentRun（2-3 周）

目标：把当前分散在 SSE、Plan、Trace 和会话中的状态统一成可恢复状态机。

建议状态：

```text
queued -> running -> waiting_for_user -> running
                  -> retrying         -> running
                  -> paused           -> running
                  -> succeeded | failed | cancelled | expired
```

交付：

- 新建 `agent_runs`、`agent_run_steps`、`agent_run_events`、`agent_run_checkpoints`；
- ReAct 和 Plan-and-Execute 共用同一 `AgentRun` 生命周期；
- `ask_user`、计划审阅、工具确认统一映射为 `waiting_for_user`；
- 每个模型轮次和工具步骤结束后写 checkpoint；
- 提供 create/get/cancel/resume/approve API；
- SSE 从持久事件流读取，断线后通过 event cursor 补发；
- 明确定义终止原因、错误分类和可重试性。

验收：

- 浏览器关闭后任务继续执行；
- SSE 断线重连不丢事件且不重复展示；
- worker 被杀后从最近 checkpoint 恢复；
- cancel 操作最终停止模型流和未开始工具；
- 同一个 run 不会被两个 worker 同时执行。

### P2：Worker、队列与副作用可靠性（2-4 周）

目标：让系统可以多实例运行，并明确 at-least-once 语义。

交付：

- 将 Agent 执行从 Next.js 请求中拆到独立 worker；
- 队列领取使用原子 claim、lease、heartbeat、ack 和 lease timeout；
- 引入重试策略：指数退避、随机抖动、最大次数和死信队列；
- 每个副作用工具要求 `idempotency_key`，结果写入执行账本；
- 工具限流迁移到 Redis，维度至少包含 tenant、user、tool；
- artifact 迁移到 S3/Supabase Storage，本地文件仅用于开发；
- Scheduler 与 AgentRun 共用可靠任务基础设施；
- 提供 DLQ 查看、重放和人工终止能力。

验收：

- worker 崩溃后任务会重领，但外部副作用只成功一次；
- 两个实例下限流结果与单实例一致；
- DLQ 中保留完整错误、尝试次数、输入摘要和关联 Trace；
- 任意实例都能读取另一个实例生成的 artifact。

### P3：租户、权限与工具治理（3-4 周）

目标：从单用户产品升级为组织可管理的平台。

交付：

- 数据模型增加 organization、workspace、membership、role；
- 建立 RBAC：owner/admin/builder/operator/viewer；
- 数据库启用并测试 RLS，service role 仅允许后台白名单路径；
- Tool Gateway 统一处理 schema、授权、风险、审批、限流、超时、重试和审计；
- 外部凭据进入 secrets vault，按 workspace 和 tool 隔离；
- 策略支持 allow/deny/require-approval，以及域名、金额、时间段等条件；
- RAG 检索和记忆召回必须继承 workspace ACL；
- 审计日志采用 append-only，和调试 Trace 分开存储。

验收：

- 所有核心表通过跨租户自动化测试；
- viewer 无法创建高风险工具审批；
- 撤销成员权限后，其 token 与待审批操作立即失效；
- 任一副作用可以回答谁、何时、在哪个 run、按哪条策略批准。

### P4：质量、发布与模型平台（3-5 周）

目标：Agent 行为变更可以量化评估、灰度和回滚。

交付：

- Eval 数据集覆盖工具路由、Plan、RAG、记忆、失败恢复、安全和预算；
- 建立三层断言：确定性断言、轨迹断言、LLM-as-judge；
- 构建 Trace replay，使用记录的工具结果对新配置重放；
- Prompt、模型、工具 schema、策略均生成不可变版本；
- CI 执行快速 mock eval，nightly 执行 live/judge eval；
- 发布系统支持基线比较、阈值门禁、灰度、A/B 和一键回滚；
- 抽象 Model Gateway，支持多供应商、超时、重试、熔断和降级；
- 线上失败和用户负反馈进入待审核 eval 样本池。

验收：

- 任何 Prompt 或模型变更都能定位到版本；
- 质量、安全或成本指标退化超过阈值时 CI 阻断；
- 单供应商故障时按策略降级，并在 Trace 中记录原因；
- 新版本可只向指定 workspace 或 5% 流量发布。

### P5：运营、成本与数据治理（持续，首期 3-4 周）

目标：系统可被企业管理员长期运营。

交付：

- 建立按 tenant/user/model/tool 的 token、费用和调用配额；
- 预算达到 80% 告警，达到 100% 后按策略降级或拒绝；
- 定义并监控成功率、p95 延迟、排队时间、工具错误率、恢复率和降级率；
- 建立 on-call 告警、运行手册、故障分级和事后复盘模板；
- 提供管理员控制台：run、审批、DLQ、配额、策略、模型版本、审计；
- 支持数据导出、删除、保留期、legal hold 和区域策略；
- 对 RAG、记忆、artifact、Trace、备份执行一致的数据删除流程；
- 定期执行恢复演练和跨租户安全测试。

验收：

- 管理员能在一个界面定位失败 run 的模型、工具、重试和审批链路；
- 删除 workspace 后，所有派生数据在规定时间内被清理；
- 月度账单能追溯到 workspace 和 run；
- 备份恢复、密钥轮换和供应商故障切换均有演练记录。

### P6：平台扩展与多 Agent（按场景启动）

目标：在可靠底座上开放生态和复杂编排，而不是提前增加运行复杂度。

候选能力：

- MCP client/server 接入与企业工具目录；
- 可版本化的 Agent Template、Skill 和 workflow；
- 子 Agent 委派、角色隔离和子任务预算；
- DAG 编排、并行 fan-out/fan-in 和人工节点；
- 跨 Agent artifact、上下文和权限的显式传递；
- Agent marketplace、审批发布和使用分析。

启动条件：至少存在两个真实业务场景，证明单 Agent + Plan-and-Execute 无法在可接受成本和可靠性下完成。

## 5. 目标数据模型

| 实体 | 关键字段 | 用途 |
|---|---|---|
| `organizations` | id, name, plan, region | 企业租户 |
| `workspaces` | id, organization_id, policy_set_id | 数据与策略边界 |
| `memberships` | user_id, workspace_id, role, status | RBAC |
| `agent_runs` | status, mode, version_set, budget, lease | 运行事实来源 |
| `agent_run_steps` | type, status, attempt, input_ref, output_ref | 模型/工具/审批步骤 |
| `agent_run_events` | sequence, type, payload, created_at | 可重放事件流 |
| `agent_run_checkpoints` | iteration, state_ref, token_state | 崩溃恢复 |
| `pending_actions` | action_hash, risk, expires_at, approved_by | 服务端审批状态 |
| `tool_executions` | idempotency_key, attempt, result_ref | 副作用去重 |
| `policy_versions` | rules, hash, published_at | 授权和治理版本 |
| `release_versions` | prompt/model/tool/policy hashes | 行为归因与回滚 |
| `audit_events` | actor, action, resource, decision, request_id | 合规审计 |

大字段、工具原始输出和 artifact 应存对象存储，数据库只保存加密引用、hash、大小、内容类型和保留期。

## 6. SLO 与发布门槛

首个企业版本建议采用以下可测目标：

| 指标 | 初始目标 |
|---|---|
| API 可用性 | 月度 >= 99.9% |
| Run 接受成功率 | >= 99.95% |
| 已接受 Run 永久丢失率 | < 0.01% |
| 队列等待 p95 | < 5 秒（普通优先级） |
| 首事件延迟 p95 | < 2 秒 |
| 可重试故障恢复率 | >= 99% |
| 未授权跨租户访问 | 0 |
| 未经审批的高风险副作用 | 0 |
| Trace 与审计关联率 | 100% |
| 费用归属到 workspace 的覆盖率 | 100% |

每次发布至少满足：

- 单元测试、集成测试和迁移检查通过；
- 跨租户、approval replay、SSRF 和 prompt injection 测试通过；
- 核心 Eval 相对基线无超阈值退化；
- 数据库迁移有前滚、回滚和兼容窗口；
- 监控面板、告警和 rollback owner 已确认。

## 7. 优先级与依赖

```text
P0 安全阻断项
  |
  v
P1 AgentRun 状态机 ---> P2 Worker/Queue/幂等
  |                           |
  +------------+--------------+
               v
        P3 租户与工具治理
               |
               v
        P4 Eval/发布/模型网关
               |
               v
        P5 运营与数据治理
               |
               v
        P6 MCP/多 Agent/生态
```

建议前 90 天只承诺以下十项：

1. cron、webhook、审批链路安全加固；
2. `AgentRun` 持久化状态机；
3. worker 与可靠队列；
4. 工具幂等和分布式限流；
5. organization/workspace/RBAC/RLS；
6. 对象存储 artifact；
7. Tool Gateway 与审计日志；
8. Eval 扩容与 CI 门禁；
9. 模型 fallback 和 circuit breaker；
10. SLO、告警和租户成本配额。

## 8. 明确非目标

以下内容不应早于 P0-P4：

- 为展示效果而引入多 Agent；
- 自研通用工作流 DSL；
- 同时支持大量模型供应商；
- 在权限和数据治理前建设工具 marketplace；
- 用模型判断替代确定性的授权、审批和计费规则；
- 在没有真实负载前做复杂的跨区域主动-主动架构。

## 9. 企业级完成定义

当以下问题都能用系统证据回答时，才可以称为企业级 Agent：

- 一个任务失败后，系统能否恢复、重试、跳过、取消或人工接管？
- 每个副作用是否可证明经过授权、审批、幂等和审计？
- 任意两家租户的数据是否在数据库、检索、记忆和 artifact 层都隔离？
- 一次异常回答能否定位到输入、模型、Prompt、工具、策略和代码版本？
- 变更上线前是否有 Eval 证据，上线后是否能灰度和回滚？
- 单一模型、Redis、worker 或外部工具故障时，系统行为是否可预测？
- 企业管理员能否控制成员、工具、数据、预算和保留策略？
- 成本、质量、安全和可靠性是否都有明确 SLO 与 owner？

这份路线图的主线不是“让 Agent 更聪明”，而是让它在多人、多租户、长时间和真实副作用场景下仍然**可控、可恢复、可审计、可运营**。
