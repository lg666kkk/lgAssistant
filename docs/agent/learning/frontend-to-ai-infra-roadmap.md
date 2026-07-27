# 前端工程师转型 AI Infra：岗位地图、能力模型与 24 周实践路线

> 适用对象：已有成熟前端工程经验，已经接触模型调用、Tool Calling、RAG、Memory、Agent Loop，希望转向 AI Infra、Agent Infra 或 AI Platform 的工程师。
>
> 本文结合 `personal-assistant` 当前源码制定。源码事实与未来建设目标分开描述，不能把路线图能力当作已经落地的项目能力。

## 0. 先给结论

前端工程师有机会转向 AI Infra，但不应把目标笼统地写成“转 AI”。AI Infra 内部跨度很大，不同方向所需基础完全不同。

对当前阶段最合理的路线是：

```text
前端工程师
  -> AI 全栈 / Agent 应用工程师
  -> Agent Runtime / LLM Application Infra
  -> AI Platform / Agent Infra 工程师
```

不建议第一份转型岗位就直接竞争以下方向：

- CUDA Kernel、算子优化、编译器；
- 大规模分布式训练；
- GPU 集群调度和高性能网络；
- 需要多年 C++、CUDA、RDMA 经验的模型训练 Infra。

更适合切入的方向是：

- Agent Runtime 与任务执行；
- Model Gateway 与多模型治理；
- Tool Gateway、权限、审批和沙箱；
- Context、RAG、Memory 等上下文服务；
- Trace、Eval、Replay、成本和质量治理；
- AI 应用的队列、状态机、失败恢复和多租户平台。

这条路线不是降低标准。它仍然要求后端、分布式系统、可靠性和安全能力，只是能复用现有 TypeScript、交互协议、流式 UI、复杂状态管理与产品工程经验。

---

## 1. AI Infra 到底是什么

AI Infra 不是单一岗位，而是支撑模型训练、部署、调用和智能应用运行的一组基础设施。

可以把完整技术栈分成四层：

```text
┌─────────────────────────────────────────────────────┐
│ Agent / AI Application Infra                        │
│ Runtime、Tools、Context、Memory、RAG、Eval、Sandbox │
├─────────────────────────────────────────────────────┤
│ Model Platform / Inference Infra                    │
│ Gateway、Routing、Serving、Batching、Cache、Quota   │
├─────────────────────────────────────────────────────┤
│ Training Infra                                      │
│ Dataset、Training Pipeline、Checkpoint、Distributed │
├─────────────────────────────────────────────────────┤
│ Compute Infra                                       │
│ GPU、CUDA、Network、Storage、Scheduler、Kubernetes  │
└─────────────────────────────────────────────────────┘
```

### 1.1 Compute Infra

主要解决 GPU 如何被高效、稳定、安全地使用：

- GPU 集群资源调度；
- 容器、Kubernetes、作业编排；
- CUDA、驱动、显存和性能分析；
- 高性能网络、存储和数据传输；
- 故障检测、资源利用率和容量管理。

典型背景是云原生、SRE、分布式系统、HPC、C++/CUDA。前端可以转，但迁移路径最长。

### 1.2 Training Infra

主要解决模型如何被可重复、可扩展地训练：

- 数据清洗、版本和血缘；
- 分布式训练任务编排；
- Checkpoint、容错和恢复；
- 实验管理与指标追踪；
- 模型评测、注册和发布。

除了工程能力，通常还要求 PyTorch、训练流程、分布式并行和一定的机器学习基础。

### 1.3 Inference / Model Platform

主要解决模型如何作为生产服务被调用：

- Model Gateway：统一不同模型供应商；
- 鉴权、租户、配额、限流和计费；
- 请求路由、降级、熔断和重试；
- Continuous Batching、KV Cache、吞吐和延迟优化；
- Prompt、模型和配置版本管理；
- Token、成本、延迟、错误率等可观测性。

这一层既有偏底层的推理引擎岗位，也有偏平台控制面的后端岗位。后者是可行的中期目标。

### 1.4 Agent / AI Application Infra

主要解决模型如何长期、可靠地完成任务：

- Agent Loop、Plan-and-Execute、Workflow、Orchestrator；
- 工具注册、调用、并发、重试、权限和审计；
- 会话状态、上下文预算、压缩和恢复；
- RAG、Memory、Artifact 等上下文服务；
- AgentRun 状态机、队列、Checkpoint、取消和恢复；
- Trace、Eval、Replay、质量门禁和成本治理；
- Prompt Injection 防护、审批、沙箱和凭证隔离；
- 多 Agent 的身份、消息、调度和故障边界。

它不是“写 Prompt”或“接模型 API”。生产级 Agent Infra 的本质是：

> 用确定性的工程系统，约束和承载一个概率性的模型执行器。

---

## 2. 四类岗位与转型难度

| 目标岗位 | 核心工作 | 前端经验复用 | 主要新增门槛 | 当前建议 |
|---|---|---:|---|---|
| 训练 / GPU Infra | 训练、算子、集群性能 | 低 | C++、CUDA、分布式训练、HPC | 暂不主攻 |
| 推理引擎 | Serving、Batching、显存和吞吐 | 低到中 | Python/C++、GPU、模型结构、性能工程 | 中长期可选 |
| AI Platform | Gateway、发布、租户、配额、观测 | 中 | Go/Java、云原生、分布式系统 | 中期目标 |
| Agent Infra | Runtime、Tools、Context、Eval、Sandbox | 高 | 后端可靠性、安全、运行时设计 | 最优切入口 |

求职时应继续查看职位描述，而不是只看岗位名称。同样叫 `AI Infra Engineer`，可能分别在招 CUDA 工程师、Kubernetes 平台工程师或 Agent Runtime 工程师。

### 2.1 优先搜索的岗位关键词

- Agent Infrastructure Engineer
- Agent Runtime Engineer
- LLM Application Infrastructure Engineer
- AI Platform Engineer
- AI Backend Engineer
- Full-stack AI Engineer
- LLM Gateway / Model Platform Engineer
- LLM Observability / Evaluation Engineer

### 2.2 谨慎投递的职位信号

当职位描述大部分是以下关键词时，说明它不是当前最佳切入口：

- CUDA、Triton、NCCL、RDMA、InfiniBand；
- Tensor Parallel、Pipeline Parallel、FSDP；
- 编译器、Kernel Fusion、算子优化；
- 多年 C++ 性能工程或 GPU 内核经验。

---

## 3. 前端经验哪些可以迁移，哪些不可以

### 3.1 可以直接迁移的能力

| 前端能力 | 在 AI Infra 中的对应价值 |
|---|---|
| TypeScript 工程化 | 快速实现 Agent Runtime、Gateway SDK、控制面 API 和工具协议 |
| 流式交互与 SSE/WebSocket | 处理模型 token、工具事件、任务进度、断线重连和回放 |
| 复杂状态管理 | 理解 AgentRun 状态机、异步任务、审批与恢复 |
| Schema 与类型系统 | 定义 Tool、Event、Trace、Plan、Context 等跨模块契约 |
| 用户体验 | 把不确定执行过程变成可理解、可取消、可恢复的产品体验 |
| 浏览器安全意识 | 延伸到 Prompt Injection、SSRF、凭证和权限边界 |
| 性能优化 | 延伸到首 token 延迟、流式背压、缓存和成本 |
| 可观测前端 | 建设 Trace、Usage、Eval、审批和任务治理控制台 |

前端背景的独特价值，不只是“能给 Infra 做一个后台页面”。成熟 AI 产品必须把计划、工具调用、证据、审批、错误和恢复暴露给用户。理解协议与交互两端的人更容易设计完整系统。

### 3.2 不能靠前端经验自动覆盖的能力

- 进程与线程、事件循环、并发和资源竞争；
- 数据库事务、索引、一致性和隔离；
- 队列的投递语义、租约、ACK、死信和重放；
- 幂等、重试、超时、熔断和背压；
- Linux、容器、网络、DNS、TLS 和服务发现；
- 分布式系统中的部分失败和最终一致性；
- 多租户鉴权、授权、审计和密钥管理；
- 服务级指标、SLO、容量和故障演练。

转型是否成功，主要取决于能否用项目证明这些能力，而不是学了多少 Agent 框架 API。

---

## 4. 当前项目在转型路线中的位置

### 4.1 已经具备的可证明能力

| 能力 | 当前源码证据 | 可以证明什么 |
|---|---|---|
| 请求编排 | `app/api/chat/route.ts` | 会话恢复、Prompt、检索规划、执行、流式响应和持久化的组合能力 |
| Agent 执行引擎 | `lib/agent/runtime/index.ts` 的 `runAgentLoop` | 多轮模型/工具循环、预算、停止条件和事件输出 |
| 受控规划 | `lib/agent/runtime/plan-execution.ts` | Plan 提案、人工审核、分步执行和工具约束 |
| 工具治理雏形 | `lib/agent/tools/tool-router.ts` | 风险分级、确认、限流元数据、超时和统一结果 |
| 工具调度 | `executeToolUsesWithScheduler` | 只读工具按组并行，写操作和高风险工具串行 |
| Context 工程 | `lib/agent/context/`、`lib/agent/prompt/` | 预算、分段、Snapshot、压缩与上下文决策 |
| RAG 与证据 | `lib/agent/rag/` | 检索路由、证据分级、引用和答案验证 |
| 分层记忆 | `lib/agent/memory/` | 召回、长期/语义存储、写入决策和生命周期 |
| Trace 与 Eval | `lib/agent/runtime/trace.ts`、`lib/agent/eval/` | 模型、工具、检索、压缩、计划、答案验证等运行证据 |
| 定时任务 | `lib/scheduler/` | Redis 到期队列、任务处理器和执行记录 |
| 部署基础 | `Dockerfile`、`docker-compose.yml` | Next.js 容器构建、非 root 用户和服务部署基础 |

这说明项目已经超过普通 AI 聊天应用，适合作为 Agent Infra 转型的主作品集。

### 4.2 必须诚实说明的生产缺口

以下能力目前不能写成“生产级已完成”：

1. **工具超时不等于隔离**  
   `tool-router.ts` 使用 `Promise.race` 返回超时，但不能终止仍在运行的底层任务。`runtime.sandboxed` 是策略元数据，不是操作系统隔离。

2. **应用容器不等于工具沙箱**  
   当前 Dockerfile 用于部署整个 Next.js 应用，不是每次工具执行的独立、可销毁沙箱。

3. **Scheduler 尚无可靠投递语义**  
   `popDueJobIds` 先读取到期任务再删除；进程在删除后、执行完成前崩溃时，任务可能永久丢失。当前缺少原子 claim、lease、ACK、DLQ 和可靠重放。

4. **限流只在单进程内有效**  
   `toolRateLimitBuckets` 是内存 Map，多副本部署时无法形成全局配额。

5. **Trace 不是完整 AgentRun**  
   Trace 主要在执行引擎内部创建并在请求结束附近保存。它适合调试，但还不能作为任务创建、排队、运行、等待审批、取消、失败和恢复的唯一事实来源。

6. **Plan-and-Execute 不是 Multi-Agent Runtime**  
   当前是同一执行引擎上的受控分步执行，没有独立 Agent 身份、邮箱/Topic、跨进程调度、父子 Run 和多 Agent 故障语义。

这些缺口不是项目失败，而是最有价值的 Infra 改造题目。

---

## 5. 目标能力模型

### 5.1 第一优先级：必须达到可面试水平

#### 后端基础

- Node.js 事件循环、异步 IO、AbortSignal 和 Stream；
- HTTP、SSE、WebSocket、DNS、TLS、连接池；
- PostgreSQL 事务、索引、锁、隔离级别；
- Redis 数据结构、原子操作、Lua 和过期策略；
- API 鉴权、授权、幂等键和错误模型。

#### 可靠性

- at-most-once、at-least-once 与 exactly-once 的现实边界；
- retry、exponential backoff、jitter、timeout、circuit breaker；
- queue、claim、lease、heartbeat、ACK、DLQ、replay；
- 状态机、不变量、Checkpoint、取消与恢复；
- 背压、限流、并发上限和资源预算。

#### Agent Runtime

- 模型调用与 Tool Calling 协议；
- Agent Loop 的终止、重复调用和预算策略；
- Workflow、Plan-and-Execute、Agent 与 Multi-Agent 的边界；
- Context、Memory、RAG 和 Artifact 的生命周期；
- 非确定性模型与确定性控制面的职责划分。

#### 可观测性与评估

- Trace、Metric、Log 的职责；
- OpenTelemetry 的 trace/span/context propagation；
- requestId、runId、toolCallId、parentRunId 的关联；
- 离线 Eval、线上评分、Golden Set、Replay、Diff；
- 延迟、错误率、成功率、Token 和成本 SLO。

#### 安全

- Prompt Injection 与数据/指令边界；
- SSRF、路径穿越、命令注入和密钥泄露；
- AuthN、AuthZ、RBAC、租户隔离和审计；
- 进程、容器、gVisor 等隔离强度；
- 最小权限、网络出口控制和一次性审批。

### 5.2 第二优先级：达到能动手使用

- Docker 镜像、网络、Volume、资源限制和健康检查；
- Kubernetes Deployment、Job、Service、ConfigMap、Secret；
- CI/CD、数据库迁移、灰度和回滚；
- Go 基础、goroutine、channel、context 和 HTTP 服务；
- 基础系统设计：负载均衡、分片、缓存和一致性。

### 5.3 暂时不必作为前置条件

- 从零训练大模型；
- 手写 Transformer；
- CUDA Kernel 优化；
- 深入掌握所有 Agent 框架；
- 同时学习 Go、Rust、C++ 和 Python；
- 为了“像 Infra”而过早引入复杂 Kubernetes 集群。

---

## 6. 语言与技术栈策略

### 6.1 TypeScript：继续作为主战语言

前 8-12 周继续用 TypeScript 改造现有项目，因为目标是快速建立可靠性和运行时能力，而不是重新实现全部业务。

需要深入的不是更多前端框架，而是：

- Node.js Runtime；
- Stream、AbortController、Worker Threads、Child Process；
- 类型化协议与状态机；
- 服务端测试、集成测试和故障注入。

### 6.2 Go：作为第二语言

Go 适合用来实现 Sandbox Broker、Worker、Model Gateway 或轻量控制面服务。学习重点：

- `context.Context` 的取消和截止时间；
- goroutine、channel、mutex；
- `net/http`、JSON、middleware；
- structured logging、metrics、tracing；
- graceful shutdown 和资源清理；
- table-driven test。

不要把“学 Go”变成脱离项目的语法刷题。最好在路线中后段用 Go 替换一个边界清晰的独立服务。

### 6.3 Python：达到 AI 生态可协作水平

至少能够：

- 阅读和修改 Python 服务；
- 使用虚拟环境、依赖和测试工具；
- 调用 PyTorch/Transformers 的基础 API；
- 编写评估、数据处理和实验脚本；
- 理解 FastAPI/asyncio 的基本运行方式。

现阶段不要求用 Python 重写 TypeScript Agent Runtime。

---

## 7. 24 周转型路线

建议每周投入 12-15 小时，其中约 60% 写代码、25% 学系统知识、15% 总结和面试表达。如果只能投入 6-8 小时，可把每个阶段周期翻倍，不要删掉验收环节。

### 阶段 0：定位与基线，第 1 周

#### 学习目标

- 能解释四类 AI Infra 的区别；
- 确定主目标为 Agent Infra / AI Platform；
- 梳理当前项目真实能力和缺口；
- 建立延迟、错误率、测试和运行成本基线。

#### 项目产出

- 一张当前系统调用链图；
- 一份 `implemented / prototype / roadmap` 能力表；
- 三个核心用例：普通问答、RAG、带副作用工具；
- 三个对应失败用例：模型超时、工具超时、存储失败。

#### 通过标准

能够在 10 分钟内回答：请求从 `/api/chat` 进入后，如何恢复上下文、选择规划或 Loop、执行工具、发 SSE、保存 Trace；同时能指出哪一步崩溃会造成什么后果。

### 阶段 1：从请求处理升级为 AgentRun，第 2-5 周

#### 学习主题

- 状态机与不变量；
- HTTP API、数据库事务和幂等；
- SSE 只是事件投影，不是状态事实来源；
- 取消、超时与进程终止的区别。

#### 项目改造

建立持久化 `AgentRun`：

```text
created -> queued -> running -> waiting_approval
                       |             |
                       |             v
                       +---------> running
                       |
                       +-> succeeded
                       +-> failed
                       +-> cancelled
```

最小字段建议：

```text
id, user_id, session_id, parent_run_id
status, version, attempt
model, prompt_version, tool_policy_version
created_at, started_at, ended_at
error_code, error_message
```

实现：

- `POST /agent-runs` 创建任务，支持 idempotency key；
- `GET /agent-runs/:id` 查询状态；
- `POST /agent-runs/:id/cancel` 取消；
- 事件表使用递增 sequence，SSE 可按游标续传；
- 状态迁移使用 CAS/version，拒绝非法跳转；
- `AgentTrace` 关联 `runId`，不再承担业务状态职责。

#### 通过标准

- 重复创建请求只产生一个 Run；
- 客户端断开不改变真实任务状态；
- SSE 重连后不丢事件、不重复渲染；
- 并发取消与完成时，只有一种合法终态；
- 单元测试覆盖全部合法和非法状态迁移。

### 阶段 2：可靠队列与 Worker，第 6-9 周

#### 学习主题

- 消息投递语义；
- claim、lease、heartbeat、ACK、DLQ；
- transient/permanent error；
- 幂等副作用与补偿；
- 背压和并发控制。

#### 项目改造

优先改造 `lib/scheduler/`：

- 原子地把任务从 `due` 移到 `processing`；
- Worker 持有有期限的 lease；
- 长任务续租；
- 成功 ACK，失败按错误类别重试；
- lease 超时重新入队；
- 超过上限进入 DLQ；
- 外部副作用使用幂等键；
- Worker 支持 graceful shutdown。

#### 故障注入

- claim 后立即终止进程；
- 工具执行成功但 ACK 前终止；
- Redis 短暂不可用；
- 数据库写入超时；
- 同一个任务被两个 Worker 竞争；
- 下游持续返回 429。

#### 通过标准

- 进程崩溃后任务最终可恢复；
- 重试不会重复创建外部副作用；
- 永久错误不做无意义重试；
- DLQ 能查看、重放和终止；
- 能准确解释为什么系统是 at-least-once，而不是宣称 exactly-once。

### 阶段 3：可观测性、Eval 与 SLO，第 10-13 周

#### 学习主题

- Log、Metric、Trace；
- OpenTelemetry Span 模型和上下文传播；
- RED：Rate、Errors、Duration；
- 离线评测与线上质量信号；
- SLI、SLO、错误预算。

#### 项目改造

建立统一关联：

```text
requestId -> runId -> modelCallId / toolCallId / retrievalId
                    -> parentRunId / childRunId
```

补齐：

- Run 从创建到终态的完整 Trace；
- 模型首 token 延迟、总延迟、Token 和成本；
- 工具成功率、P50/P95/P99 延迟、重试次数；
- 队列等待时间、运行时间、lease 超时和 DLQ 数；
- RAG 检索命中、引用覆盖和 groundedness；
- Golden Set、回归基线、Replay 和 Diff；
- CI 中的关键 Eval 门禁。

建议先定义少量真实 SLO：

- Run 终态记录完整率；
- 安全工具未审批执行次数必须为 0；
- 关键任务最终成功率；
- P95 排队时间和执行时间；
- 每类任务的平均 Token 成本。

#### 通过标准

拿到一个失败 `runId` 后，能回答：在哪个阶段失败、使用哪个模型/Prompt/工具版本、是否重试、消耗多少 Token、用户是否收到终态，以及相同版本的历史失败率。

### 阶段 4：Tool Gateway 与 Sandbox Broker，第 14-17 周

#### 学习主题

- 认证、授权、策略和审计的区别；
- Prompt Injection、SSRF 和路径隔离；
- 进程、容器、gVisor、MicroVM 的边界；
- CPU、内存、进程数、磁盘和网络配额；
- 凭证代理与最小权限。

#### 项目改造

先把工具执行从 Next.js 请求进程中抽离：

```text
Agent Runtime
    |
    v
Tool Gateway: policy / approval / audit / idempotency
    |
    +--> Connector Executor: Notion、搜索、数据库
    |
    +--> Sandbox Broker --> isolated process/container
```

关键要求：

- Runtime 只发送结构化 ToolExecutionRequest；
- 一次性审批绑定用户、工具名、参数哈希、Run 和过期时间；
- 沙箱任务可真正 kill，而不是仅让调用方超时；
- 沙箱内没有数据库和模型密钥；
- 默认禁止网络，按域名/目标开放；
- 文件系统只挂载任务所需目录；
- stdout、stderr、退出码和资源使用进入 Trace；
- Tool Gateway 记录 append-only 审计日志；
- 不把宿主机 `docker.sock` 暴露给应用。

可以先用 Docker Broker 建立接口和生命周期，再在确有不可信代码、多租户或共享主机需求时切换到 gVisor。

#### 通过标准

- 无限循环能被到期终止，底层进程不再继续运行；
- 越权路径、私网地址和未授权网络请求被拒绝；
- 修改审批后的工具参数无法执行；
- 同一审批不可重放；
- 沙箱进程拿不到业务密钥；
- 能解释容器、gVisor 和 Firecracker 的取舍。

### 阶段 5：Model Gateway 与平台治理，第 18-21 周

#### 学习主题

- 多供应商适配和统一错误模型；
- 限流、配额、熔断、降级和成本路由；
- 配置、Prompt、模型和策略版本；
- 多租户隔离与 RBAC；
- 灰度发布和回滚。

#### 项目改造

- 建立统一 Model Provider 接口和规范化错误码；
- 按 tenant/user/model 使用 Redis 限流；
- 区分 429、超时、5xx、参数错误和内容拒绝；
- 对安全的瞬时错误做受控重试；
- 配置模型 fallback，但防止无限级联和成本失控；
- 给 Prompt、工具策略和模型配置加版本；
- Trace 记录实际命中的 provider/model/version；
- 建立租户预算、熔断和用量查询；
- 用回归 Eval 决定配置是否允许发布。

#### 通过标准

- 单一模型供应商故障时能按策略降级；
- 降级过程可观察、可限额、不会重复副作用；
- 可以按租户回答使用量、成本和失败率；
- 任一线上回答都能定位其模型和配置版本；
- 回滚后能够比较前后 Eval 与线上指标。

### 阶段 6：作品集、面试与投递，第 22-24 周

#### 作品集材料

- 一页架构图；
- 一次 Run 的时序图；
- AgentRun 状态机；
- 队列故障恢复演示；
- Sandbox 越权阻断演示；
- Trace/Eval 控制台截图；
- 一份故障复盘；
- 一份压测和容量报告；
- `implemented / prototype / roadmap` 能力清单。

#### 通过标准

能够完成三种深度的项目介绍：

- 30 秒：定位、用户问题、最关键架构；
- 5 分钟：请求链路、核心取舍、结果；
- 30 分钟：状态、可靠性、安全、观测、故障和后续演进。

开始投递不必等到第 24 周。完成阶段 2 后可以投 AI 全栈和 Agent 应用岗位；完成阶段 4 后重点投 Agent Infra；完成阶段 5 后扩大到 AI Platform。

---

## 8. 把 personal-assistant 改造成 Infra 作品集

作品集的目标不是继续增加日历、天气、更多模型或更多页面，而是把一个非确定性 Agent 变成可控运行系统。

### 8.1 建议的六个里程碑

| 里程碑 | 核心问题 | 关键产出 | 面试价值 |
|---|---|---|---|
| M1 AgentRun | 请求断开后任务是什么状态 | 状态机、事件表、取消和续传 | Runtime 设计 |
| M2 Reliable Worker | 进程崩溃后任务是否丢失 | lease、ACK、DLQ、幂等 | 分布式可靠性 |
| M3 Observability | 为什么失败、影响多大 | OTel、SLO、Replay、Eval | 生产治理 |
| M4 Tool Gateway | 模型为什么有权执行动作 | Policy、Approval、Audit | 控制面设计 |
| M5 Sandbox Broker | 不可信代码在哪里运行 | 隔离、资源和网络策略 | 安全边界 |
| M6 Model Platform | 多模型如何稳定、经济地服务 | Gateway、Quota、Fallback | AI Platform |

建议严格按顺序推进。没有 AgentRun 和可靠队列时，过早做多 Agent 只会放大状态与故障问题。

### 8.2 每个里程碑必须同时交付的内容

- 架构决策记录：为什么选这个方案；
- 数据模型和协议；
- 正常路径测试；
- 至少三个故障注入测试；
- 指标和 Trace；
- 安全边界；
- 部署与回滚说明；
- 已知限制。

### 8.3 不要用代码行数衡量成果

Infra 项目更有价值的量化指标包括：

- 崩溃恢复后任务成功率；
- 副作用重复执行次数；
- Run 终态记录完整率；
- P95 排队和执行延迟；
- 每类任务平均 Token 成本；
- Eval 通过率和版本回归幅度；
- 未审批副作用执行次数；
- 沙箱逃逸和越权测试通过率。

---

## 9. 学习方法与每周节奏

### 9.1 推荐节奏

| 时间 | 内容 |
|---|---|
| 2 小时 | 学一个系统概念，写出自己的不变量和失败场景 |
| 6-8 小时 | 在项目中实现最小闭环 |
| 2 小时 | 写测试与故障注入，不只跑正常路径 |
| 1 小时 | 画调用链或状态机，整理决策和限制 |
| 1 小时 | 用面试语言复述，并回答追问 |

### 9.2 推荐资料类型

按问题查资料，不建议同时铺开大量课程：

- 分布式系统：《Designing Data-Intensive Applications》；
- 操作系统与网络：进程、虚拟内存、TCP、DNS、TLS 的专项资料；
- Go：官方 Tour、Effective Go、标准库和并发模式；
- 容器与 Kubernetes：官方概念文档和本地实践；
- 可观测性：OpenTelemetry 官方文档、Trace/Metric 语义；
- 安全：OWASP、SSRF、命令注入、容器隔离和最小权限；
- Agent：优先阅读成熟项目的 Runtime、Tool、Context、Trace 源码，而不是只读框架教程。

### 9.3 学习闭环

每学一个概念，都回答以下五个问题：

1. 它解决什么失败场景？
2. 系统必须维持什么不变量？
3. 当前项目在哪里违反这个不变量？
4. 最小改造是什么？
5. 如何用测试和指标证明改造有效？

---

## 10. 面试准备地图

### 10.1 编码

- TypeScript/Go 常用数据结构；
- 并发控制、任务池、限流器；
- 状态机和幂等 API；
- 流式协议解析；
- 错误分类和重试器；
- LRU/TTL Cache。

### 10.2 后端与分布式系统

- Redis 队列为什么会丢任务；
- 如何设计 lease 和 heartbeat；
- 如何处理重复消息和重复副作用；
- 数据库事务与消息发布如何保证一致；
- 如何设计取消和超时；
- 如何做限流、熔断和背压；
- 如何设计多租户配额。

### 10.3 AI / Agent

- Tool Calling 的协议和执行边界；
- ReAct、Workflow、Plan-and-Execute 的取舍；
- Agent Loop 如何防止无限循环；
- Context 与 Memory 的差别；
- RAG 如何评估检索和最终答案；
- 模型错误与工具错误如何分类；
- Multi-Agent 何时真正必要；
- 为什么模型不能负责权限判断。

### 10.4 系统设计

重点练习：

- 设计一个可恢复的 Agent Runtime；
- 设计多模型 Gateway；
- 设计代码执行沙箱；
- 设计 Agent Trace 和 Replay；
- 设计十万日活的 RAG 服务；
- 设计多租户 Tool Gateway；
- 设计支持暂停、审批和恢复的长任务系统。

回答系统设计题时始终覆盖：

```text
需求和 SLO
-> 数据模型与 API
-> 正常调用链
-> 状态与一致性
-> 扩展性与成本
-> 故障与恢复
-> 安全与租户隔离
-> 观测与验证
```

---

## 11. 简历和项目表达

### 11.1 定位

不要只写：

> 前端工程师，熟悉 React，使用大模型 API 开发了个人助手。

更合适的定位是：

> 具备成熟前端产品工程经验，重点建设 Agent Runtime、工具执行、上下文服务、评估观测与安全控制面的 AI 全栈工程师。

### 11.2 项目描述公式

每条经历使用：

```text
生产问题 + 架构设计 + 关键机制 + 可验证结果
```

示例表达，只有完成对应改造后才能使用：

- 设计持久化 `AgentRun` 状态机和可续传事件流，使客户端断开不影响任务执行，并通过 CAS 保证并发终态唯一；
- 将 Redis 到期任务改造成 lease/ACK/DLQ 的 at-least-once Worker，通过故障注入验证进程崩溃后任务可恢复，外部副作用由幂等键去重；
- 建立 Agent 全链路 Trace，将 Run、模型、工具、检索和配置版本关联，使用 Golden Set 与 Replay 作为发布回归门禁；
- 抽离 Tool Gateway 与 Sandbox Broker，将审批绑定具体参数哈希，并在无业务密钥、受限文件系统和网络策略下执行不可信任务。

不要使用无法证明的词：

- “企业级”；
- “高并发”；
- “高可用”；
- “完全安全”；
- “exactly-once”；
- “自主多 Agent 平台”。

除非有架构、测试、指标或运行数据支撑。

### 11.3 前端经历不需要隐藏

前端经验可以体现为差异化能力：

- 设计结构化 Agent Event Protocol；
- 实现流式响应、断线重连和事件回放；
- 把工具审批、计划审核和执行状态变成清晰交互；
- 构建 Trace、Eval、Usage、Policy 控制台；
- 从用户体验反推 Runtime 必须提供的取消、恢复和解释能力。

目标不是伪装成工作多年的底层工程师，而是证明自己已经能承担 Agent Infra 的关键模块。

---

## 12. 常见误区

### 误区 1：先学完整套 AI 理论再做 Infra

Agent Infra 需要理解 Token、Embedding、Transformer 推理和模型限制，但第一阶段不需要先掌握完整训练数学。系统知识和工程闭环更紧迫。

### 误区 2：会 LangChain/LangGraph 就等于会 Agent Infra

框架能加快开发，不能替代对状态、失败、权限、队列和可观测性的理解。面试时通常会继续追问框架下面发生了什么。

### 误区 3：工具越多，项目越成熟

成熟度更取决于：工具失败能否恢复、危险操作能否阻止、行为能否审计、版本能否回归、成本能否控制。

### 误区 4：超时就是取消，容器就是沙箱

调用方停止等待不代表底层工作停止；部署容器也不代表不可信任务获得了独立隔离。必须明确执行主体、终止机制、权限和资源边界。

### 误区 5：一开始就做 Multi-Agent

如果单 Agent Run 还不能持久化、取消、恢复和观测，多 Agent 只会增加消息、身份、并发和故障组合。先把单 Agent Runtime 做可靠。

### 误区 6：为了转 Infra 放弃所有前端优势

AI Infra 仍然需要 SDK、协议、控制台和复杂执行体验。应补后端深度，而不是抹掉已有能力。

---

## 13. 前 30 天执行清单

### 第 1 周：基线和系统地图

- 画出 `/api/chat -> plan/runAgentLoop -> tool -> trace -> persistence` 调用链；
- 列出至少 10 个失败点；
- 为当前 Agent 定义 3 个核心 SLI；
- 整理实现、原型和路线图能力表。

### 第 2 周：AgentRun 设计

- 定义状态、事件、合法迁移和不变量；
- 设计数据库表和 API；
- 明确 Trace 与 Run 的职责；
- 写状态机单元测试，再接入业务。

### 第 3 周：持久化与续传

- 创建、查询、取消 Run；
- 持久化带 sequence 的事件；
- SSE 支持 cursor 重连；
- 测试断线、重复请求和并发终态。

### 第 4 周：可靠队列设计

- 为现有 Scheduler 写出丢任务复现测试；
- 设计 due/processing/DLQ；
- 实现最小 lease 和 ACK；
- 用终止 Worker 的方式验证任务恢复。

30 天结束时，不要求项目已经成为完整平台，但应当出现明确变化：你讨论的不再只是模型效果，而是任务状态、投递语义、故障恢复和系统不变量。

---

## 14. 转型完成度检查表

达到以下大部分条件后，可以把求职主定位从“前端 / AI 应用”切换为“Agent Infra / AI Platform”：

- [ ] 能独立设计持久化 AgentRun 状态机；
- [ ] 能解释并实现 at-least-once Worker；
- [ ] 能通过幂等机制控制重复副作用；
- [ ] 能设计模型和工具的错误分类、重试、熔断；
- [ ] 能用 OTel 关联一次 Run 的完整链路；
- [ ] 能建立少量真实 SLO 和告警；
- [ ] 能设计离线 Eval、Replay 和发布门禁；
- [ ] 能区分策略元数据、调用超时和真实沙箱隔离；
- [ ] 能设计多租户鉴权、配额和审计；
- [ ] 能使用 Docker 部署，并理解 Kubernetes 基础对象；
- [ ] 能使用 Go 实现并测试一个独立服务；
- [ ] 能完成一场 30 分钟的 Agent Runtime 系统设计；
- [ ] 简历中的关键结论都有代码、测试、指标或演示支撑。

最终判断标准不是“学完了哪些技术”，而是：

> 能否把一个可能超时、犯错、重复调用和产生副作用的 Agent，建设成可控、可恢复、可观测、可审计的生产系统。
