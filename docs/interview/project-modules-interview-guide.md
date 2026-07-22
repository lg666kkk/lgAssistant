# Personal Assistant 项目模块总结与面试题

> 本文完全按当前生产代码划分模块，用于大厂 Agent 应用开发、AI 全栈、RAG 和 Agent 平台方向面试。每个模块包含：职责、真实链路、项目亮点、已知边界和面试题回答要点。
>
> 推荐回答结构：**先给结论 → 讲项目实现 → 解释取舍 → 承认边界 → 给出验证或演进方案**。不要把声明但未强制执行的策略说成已经具备的隔离能力，也不要把单元测试等同于生产验证。

## 一、项目总览

### 1. 项目定位

这是一个基于 Next.js、TypeScript、Supabase、Redis 和 Langfuse 构建的个人 Agent 应用。它不是单纯的聊天 UI，而是包含以下闭环：

```text
Chat UI / SSE
  → 身份认证与会话恢复
  → Prompt、Context、Memory 组装
  → RetrievalPlan 与工具可见性过滤
  → Plan Review 或 Agent Loop
  → 工具调度与证据收集
  → 最终回答与 Groundedness Guard
  → Session / Snapshot / Trace / Usage 持久化
```

### 2. 模块地图

| 模块 | 解决的问题 | 核心代码 |
|---|---|---|
| Chat UI 与 SSE | 把 Agent 的文本、计划、工具、来源和用量变成可交互状态 | `app/page.tsx`、`lib/chat/*`、`lib/agent/runtime/events.ts` |
| Chat API 编排 | 串联认证、上下文、记忆、RAG、计划、执行和终态持久化 | `app/api/chat/route.ts` |
| 模型与 Provider | 屏蔽模型协议差异并采集真实 usage | `lib/agent/runtime/model-provider.ts`、`lib/agent/models.ts` |
| Agent Runtime | 实现模型—工具循环、预算、终止和最终回答 | `lib/agent/runtime/index.ts` |
| Plan-and-Execute | 复杂任务先规划、审核，再按步骤受控执行 | `lib/agent/runtime/plan-execution.ts` |
| 工具系统与安全 | 注册、过滤、调度、确认、限流和执行工具 | `lib/agent/tools/*` |
| Prompt 与 Context | 管理上下文来源、优先级、Token 和跨请求快照 | `lib/agent/prompt/*`、`lib/agent/context/*`、`lib/agent/runtime/compaction.ts` |
| 记忆系统 | 会话连续性、长期事实、语义召回和显式忘记 | `lib/agent/memory/*` |
| RAG 与知识库 | Notion 摄取、混合检索、证据门控和回答校验 | `lib/knowledge/*`、`lib/agent/rag/*` |
| 可观测性与评测 | 记录执行时间线、成本、质量指标和回归结果 | `lib/agent/runtime/trace*`、`lib/agent/eval/*`、`app/traces/*` |
| Scheduler | 把提醒、刷题和 Agent Task 变成定时任务 | `lib/scheduler/*`、`app/api/cron/*` |
| Auth、配置与数据隔离 | 用户认证、管理员配置、密钥加密和租户过滤 | `lib/auth/*`、`lib/runtime-config/*`、`lib/platform/*` |
| 部署与运维 | 生产构建、SSE 代理、本地 Artifact 和清理任务 | `Dockerfile`、`docker-compose.yml`、`deploy/nginx.conf`、`scripts/*` |

---

## 二、Chat UI、Session 与 SSE

### 功能总结

- `ChatSession` 维护单会话的消息、流式状态、AbortController、计划和工具调用。
- 前端每轮只向 `/api/chat` 发送当前用户消息，历史由服务端通过 Snapshot、Redis 或数据库恢复。
- SSE 不是纯文本流，而是 `text`、`tool_call`、`sources`、`model_usage`、`context_usage`、`plan_proposal`、`plan_progress`、`error` 和 `done` 的判别联合。
- 用户能审核、编辑执行计划；失败步骤能重试或跳过；写工具能在 UI 中二次确认。
- 会话和消息由 Supabase 持久化，用户中止生成时保存已有部分回答并标记 interrupted。

### 项目亮点与边界

- **亮点**：把 Agent 内部状态显式产品化，前端不是“打印模型字符串”。
- **亮点**：共享 TypeScript 事件类型，减少前后端协议漂移。
- **边界**：默认 `openWhenHidden` 会让后台标签页继续消耗模型资源；需要结合产品策略决定。
- **边界**：当前页面体积较大，Markdown 与语法高亮可继续按需加载。

### 面试题

#### Q1. 为什么 Agent 流式协议不能只有文本 delta？

**回答要点**：Agent 一次运行包含模型输出、工具请求、证据来源、计划状态、Token 用量和终态。把这些编码进自然语言会造成 UI 无法可靠解析、状态不可恢复。项目用判别联合定义结构化事件，文本只是其中一种事件。

#### Q2. SSE、WebSocket 和普通 fetch streaming 如何选择？

**回答要点**：当前主要是服务端到客户端的单向增量输出，SSE 语义简单、可经过 HTTP 基础设施、方便按事件类型处理。工具确认和计划执行仍走普通 POST。若未来需要持续双向协作、多端同步或低延迟控制信号，再考虑 WebSocket。

#### Q3. 如何处理用户点击“停止生成”？

**回答要点**：前端 AbortController 取消请求；服务端通过 `req.signal.aborted` 和 `shouldStop` 检查退出；Trace 应写入 `aborted` 终态；前端保存已有部分回答。关键是把“传输关闭”和“任务完成”分开，不能把客户端断开统计成成功。

#### Q4. 为什么前端只发送当前消息，而不每次发送完整历史？

**回答要点**：减少请求体、避免客户端成为历史真相源，并允许服务端统一做压缩和恢复。代价是服务端状态依赖更重，所以项目增加 Snapshot、Redis 和数据库多级恢复。

#### Q5. SSE 如何避免重连导致重复执行工具？

**回答要点**：当前客户端在 `onerror` 中抛出错误以停止库的自动重连。更成熟方案还应给 Run 和副作用工具增加幂等键，使网络重试也不会重复写入。

---

## 三、Chat API 主编排

### 功能总结

`POST /api/chat` 是当前生产控制面，依次完成：认证和输入校验、会话恢复、RetrievalPlan、工具过滤、SSE 建立、记忆召回、Prompt Pipe、ContextPlan、计划提案或执行、最终答案校验、Session/Snapshot/Trace/Langfuse 持久化。

### 项目亮点与边界

- **亮点**：生产请求真实串联全部 Agent 能力，不是孤立组件演示。
- **亮点**：记忆、Trace 或外部评分失败时尽量不阻断聊天主链路。
- **边界**：单个 Route 承担职责过多，接近千行，事务边界和集成测试都较难维护。
- **边界**：部分写入采用 fire-and-forget，在短生命周期运行时可能丢失。

### 面试题

#### Q1. 一个成熟 Agent API 的控制面应该负责什么？

**回答要点**：负责身份、租户、上下文、策略、预算、运行生命周期、持久化和观测；模型只负责生成候选动作，不能成为权限和事务控制面。

#### Q2. 为什么某些依赖失败可以降级，某些不能？

**回答要点**：按正确性分级。Langfuse 上报失败可以降级；显式私有知识请求却检索不到证据时不能假装回答；写工具确认和用户隔离失败必须阻断。是否降级取决于失败会不会破坏安全、事实正确性或用户承诺。

#### Q3. 如何重构当前巨型 Route？

**回答要点**：Route 只做 HTTP/SSE 适配；拆出 `ChatRunService`、`ContextAssembler`、`ExecutionCoordinator`、`RunFinalizer`；所有分支使用统一 Run 状态机和终态持久化；副作用通过 outbox/queue 交付。

#### Q4. 如何让整个请求具备幂等性？

**回答要点**：客户端生成 requestId；数据库建立唯一约束；模型调用、工具调用和写入分别记录幂等键；副作用工具以 toolCallId 原子消费；重试时恢复已有 Run，而不是创建第二次执行。

---

## 四、模型 Provider 与用量

### 功能总结

- 使用 AI SDK 对接 OpenAI-compatible DeepSeek 接口。
- 将 Anthropic 风格的 message/tool block 转换为 AI SDK message/tool schema，再把工具调用转换回内部统一类型。
- 提供流式 Agent 调用、非流式规划/压缩调用和最终回答流。
- 将真实 usage 映射成输入、输出、缓存命中/未命中 Token，并估算人民币成本。

### 项目亮点与边界

- **亮点**：Agent Runtime 依赖内部协议，Provider 细节集中在适配层。
- **边界**：产品类型、价格和上下文窗口仍写死为两个 DeepSeek 模型，因此是“有适配层的单 Provider 应用”，不是完整模型网关。

### 面试题

#### Q1. 为什么需要 Provider Adapter，而不是在业务代码直接调用 SDK？

**回答要点**：隔离消息格式、工具 Schema、stop reason、usage 和错误语义；便于测试时注入 mock model，也降低未来切换 Provider 对 Runtime 的影响。

#### Q2. 不同模型的工具调用协议如何统一？

**回答要点**：内部定义稳定的 `tool_use/tool_result` 语义；适配层负责转换 Provider 特有格式；Runtime 只消费统一的文本块、工具块、stop reason 和 usage。

#### Q3. 为什么本地 Token 估算和 Provider usage 都要保留？

**回答要点**：调用前只能靠本地估算做预算和压缩；调用后用 Provider usage 做真实计费与监控。两者用途不同，不能拿估算值冒充账单。

#### Q4. 如何演进为企业级模型网关？

**回答要点**：增加 Provider/Model capability registry、超时重试、熔断、fallback、配额、价格版本、数据驻留策略、请求日志和统一错误码；按能力路由而不是在业务里判断模型名称。

---

## 五、Agent Runtime 与 Plan-and-Execute

### 功能总结

- Agent Loop 每轮先压缩和计算请求预算，再调用模型、解析工具、执行工具并把结果回灌。
- 有最大工具轮数、累计 Token 预算、输出预留、重复调用检测、用户中止、工具确认和追问等终止原因。
- 工具可按安全策略并行执行；工具结果被整形、截断或保存成 Artifact。
- 复杂任务先生成2至4步计划，前端审核后按步骤限制工具执行；步骤失败可恢复或跳过。

### 项目亮点与边界

- **亮点**：不是让模型拥有控制权，而是 Runtime 执行模型提出的候选动作。
- **亮点**：简单请求不强制规划，避免无意义延迟；复杂请求才引入 Human-in-the-loop。
- **边界**：成功标准目前主要依赖“Loop完成、无工具失败、有文本输出”，不是独立 Verifier 的语义验收。

### 面试题

#### Q1. ReAct 与 Plan-and-Execute 的差异是什么？

**回答要点**：ReAct 每轮根据最新观察决定下一动作，灵活但容易局部循环；Plan-and-Execute 先建立全局步骤和工具边界，更可解释、可恢复，但增加模型调用和计划漂移风险。项目按任务复杂度选择路径。

#### Q2. 如何防止 Agent 无限循环？

**回答要点**：最大迭代数、累计 Token 预算、重复工具签名、每类检索工具调用预算、超时、用户中止和明确 stop reason。单一 `maxIterations` 不够，因为一次迭代仍可能很贵。

#### Q3. 为什么要为输出预留 Token？

**回答要点**：如果输入刚好占满窗口，模型没有空间生成工具参数或最终回答。预算判断应使用“预计输入 + 输出预留”，压缩后仍不足则停止继续调用工具。

#### Q4. 计划中的 `allowedTools` 有什么价值？

**回答要点**：最小权限和减少模型选择空间；分析步骤不应获得写工具，非检索步骤不应重复消耗检索预算。服务端必须重新校验用户编辑过的计划。

#### Q5. 如何判断一个计划步骤真的完成？

**回答要点**：当前是确定性运行信号；更成熟实现应把成功标准结构化，使用规则或独立 verifier 检查产物、证据和副作用状态，并把“执行成功”和“业务目标达成”分开。

#### Q6. 为什么最终回答可能需要单独一次模型调用？

**回答要点**：工具循环可能因轮数、预算或重复调用停止，已有观察仍可用于汇总。最终调用只允许生成回答、不再继续工具循环，并在有证据时经过 groundedness guard。

---

## 六、工具系统、风险控制与 Artifact

### 功能总结

- Registry 管理时间、计算器、知识库、Web、待办、调度、LeetCode、追问和 Artifact 读取工具。
- 工具声明输入 Schema、风险等级和 Runtime Policy。
- Router 负责存在性检查、确认、危险阻断、限流、超时、上下文注入和结果标准化。
- Scheduler 按风险、side effect 和 concurrency group 决定并行或串行。
- 大结果存到本地 Artifact，模型先获得摘要，需要时再分页读取原文。

### 项目亮点与边界

- **亮点**：工具不是普通函数集合，而是受策略控制的能力边界。
- **亮点**：Artifact 避免一次工具结果挤爆 Context Window。
- **边界**：`sandboxed`、`memoryLimitMb`、`requiresAuth` 等字段尚未全部转化为强制隔离机制。
- **边界**：确认接口目前没有用一次性记录绑定原始待确认调用，存在参数修改和重放边界。

### 面试题

#### Q1. Tool Registry 和 Tool Router 为什么要分开？

**回答要点**：Registry 负责能力发现和模型 Schema；Router 负责策略执行、身份上下文、确认、限流、超时和结果规范化。分开后工具定义不会各自复制治理逻辑。

#### Q2. 哪些工具可以并行？

**回答要点**：无副作用、无需确认、非危险的读工具可以按 concurrency group 并行；写工具、外部副作用或有顺序依赖的工具串行。并行前还要考虑 Provider 和下游限流。

#### Q3. 为什么“用户确认”不能只是前端弹窗？

**回答要点**：服务端必须保存原始 toolCall、参数摘要、用户、Run、过期时间和状态；确认时原子消费一次性 ID。否则客户端可以修改参数、重放或绕过 Agent 提议阶段。

#### Q4. 工具超时后，底层任务真的停止了吗？

**回答要点**：`Promise.race` 只让调用方停止等待，不会自动取消底层 I/O。工具接口还应接受 AbortSignal，并确保数据库、HTTP 和子进程支持取消或具备幂等补偿。

#### Q5. Artifact 为什么不直接全部塞进 Prompt？

**回答要点**：降低 Token、延迟和 Prompt Injection 暴露面；模型先看摘要和 artifactId，只有任务需要时才分页读取。生产多实例下本地文件应迁移到对象存储。

#### Q6. Tool Schema 如何防御模型产生非法参数？

**回答要点**：Schema 只帮助模型生成，并不替代服务端验证。项目当前有结构检查，成熟方案应统一使用 Zod/JSON Schema runtime validation、长度上限、枚举和业务约束。

---

## 七、Prompt、Context 与 Token 管理

### 功能总结

- Prompt Pipe 将身份、记忆操作、长期记忆、检索计划、证据策略和 Web 策略拆成带优先级、来源、trust 和 Token 上限的 Segment。
- ContextPlan 记录每个来源保留/截断/省略的决策、内容 Hash 和 Token 数，不直接保存全部源内容。
- Context Snapshot 跨请求保存版本化消息、摘要、Artifact 引用和策略版本。
- Agent Loop 在阈值触发或预算不足时压缩中间消息，保留 primer、近期消息以及 tool_use/tool_result 原子组。

### 项目亮点与边界

- **亮点**：上下文从字符串拼接升级为可预算、可审计的数据结构。
- **亮点**：区分 trusted runtime、user 和 external 内容，为 Prompt Injection 治理提供基础。
- **边界**：ContextPlan 当前主要是记录决策，尚未成为统一 Context Compiler 的唯一执行入口。

### 面试题

#### Q1. Context Window 大了，为什么还需要上下文管理？

**回答要点**：窗口越大不等于免费；成本、延迟、缓存命中和 lost-in-the-middle 仍存在。上下文管理的目标是保留约束和证据，而不是尽可能塞满。

#### Q2. Prompt Segment 比拼接字符串好在哪里？

**回答要点**：能为不同来源设置优先级、预算、trust 和动态性；能在 Trace 中解释某段为何被保留或裁剪；也方便稳定段参与 Prompt Cache。

#### Q3. 如何压缩历史而不破坏工具协议？

**回答要点**：不能单条切消息；应把 assistant 的 `tool_use` 与对应 user/tool 的 `tool_result` 视为原子组。摘要还要保留用户约束、失败状态和 artifactId。

#### Q4. Snapshot、Redis History 和数据库消息是什么关系？

**回答要点**：Snapshot 是执行上下文快照；Redis 是低延迟会话缓存；数据库消息是用户可见的持久记录。它们语义不同，恢复时需要明确优先级、版本和去重规则。

#### Q5. 如何防止外部知识中的 Prompt Injection 覆盖系统指令？

**回答要点**：结构化 trust label、明确数据边界、外部内容不进入高权限指令段；读取不可信内容后发起副作用工具应重新确认；配合 injection eval，而不是只写一句“忽略恶意指令”。

#### Q6. 如何提高 Prompt Cache 命中率？

**回答要点**：稳定身份和策略段放前面，动态记忆、检索和时间放后面；避免每轮变化的字段污染前缀；对 Segment 做稳定排序和版本化。

---

## 八、分层记忆系统

### 功能总结

- Session Store 用 Redis 保存短期会话历史，并按 `userId + sessionId` 隔离。
- LongTerm Store 保存结构化稳定事实；Semantic Store 用向量做语义召回。
- 召回前先判断问题是否需要长期记忆，再按置信度、重要性、访问时间等排序。
- Consolidation 只抽取能回指用户原文的稳定事实，拒绝凭据和身份证件等敏感内容。
- 写入时区分新增、更新和重复，并通过 RPC 原子维护长期层与语义层。
- 用户可以显式要求忘记，系统对相关记忆执行软失效并向模型注入可信操作结果。

### 项目亮点与边界

- **亮点**：把会话、用户画像事实、语义索引和知识库分成不同生命周期。
- **亮点**：记忆写入不是无条件 LLM 抽取，带原文依据和确定性决策。
- **边界**：Consolidation 仍是请求后的异步任务，短生命周期部署下需要可靠队列。

### 面试题

#### Q1. 会话历史、长期记忆和 RAG 为什么必须分开？

**回答要点**：会话历史保存当前任务过程；长期记忆保存稳定用户事实；RAG 保存外部知识证据。三者来源、可信度、删除规则、召回方式和 Token 优先级都不同。

#### Q2. 什么内容不应该写入长期记忆？

**回答要点**：一次性任务、中间推理、模型猜测、未经用户支持的事实、密码/Token/证件号、很快过期的信息。项目要求事实能回指用户原文并通过敏感内容过滤。

#### Q3. 如何解决长期记忆与语义索引双写一致性？

**回答要点**：不能先写一张表再 best-effort 写另一张表。项目通过数据库 RPC 在同一事务完成主记录和派生语义记录；更大规模可采用主记录 + outbox + 可重建索引。

#### Q4. 记忆召回为什么需要门控？

**回答要点**：每轮都召回会增加延迟、成本和无关画像污染。只有显式记忆、偏好、个人信息或连续性问题才进入长期召回，再做置信度和状态过滤。

#### Q5. 用户说“忘记我的饮食偏好”时如何实现？

**回答要点**：识别显式忘记意图和主题；按用户隔离查找相关 key；软失效并记录原因、requestId 和时间；从后续召回排除；向当前模型注入真实操作结果，不能让模型自行声称已经删除。

#### Q6. 如何评测记忆系统？

**回答要点**：写入 precision、错误记忆率、重复率、更新一致性、召回 Recall/Precision、跨用户泄漏率、忘记完成率和陈旧记忆率；必须同时有 should-write、should-not-write 和 conflict case。

---

## 九、RAG 与知识库

### 功能总结

- Notion 页面经过结构/Token 感知切块、Embedding 校验和 PostgreSQL 原子替换进入索引。
- 在线请求先生成 RetrievalPlan，再按 `knowledge`、`web`、`both` 或 `no_retrieval` 控制工具可见性。
- 私有知识检索包含 Query Rewrite、多路向量与关键词并行召回、RRF/加权融合、规则或 Cross-Encoder 重排、向量 MMR、Parent Context 和 Evidence Gate。
- Web Search/Fetch 同样产出 EvidenceBundle；最终答案执行 Claim-level 引用与 groundedness 校验。
- Ingestion worker 有 lease、指数退避、dead 状态、索引快照和回滚路径。

### 面试材料

RAG 已有独立的64道深挖题库，不在本文重复：

- [RAG 面试题库](./rag-interview-questions.md)
- 推荐重点：Q2完整链路、Q10多租户、Q18融合、Q24原子同步、Q28 Prompt Injection、Q30指标、Q35 Ablation、Q43发布门禁、Q48自纠错检索、Q59 Claim-level Attribution。

### 跨模块追问

#### Q1. RetrievalPlan 和执行计划有什么区别？

**回答要点**：RetrievalPlan 决定是否需要证据、使用哪个数据源、查询和过滤条件；ExecutionPlan 决定复杂任务有哪些业务步骤、每步允许什么工具。执行时还要把全局 RetrievalPlan 收窄到当前步骤工具。

#### Q2. 为什么显式证据请求和知识画像软命中要区别处理？

**回答要点**：用户明确要求“查我的笔记/最新官网”时，没有证据就不能可靠回答；画像相似只是优化建议，检索失败可以回到普通回答。项目用 `evidenceRequired` 表达这一区别。

---

## 十、Trace、Usage、Eval 与质量治理

### 功能总结

- AgentTrace 用判别联合记录 model、tool、context_compaction、plan、retrieval 和 answer_validation 步骤。
- Metrics 聚合模型调用、真实 Token、缓存、费用、工具次数和耗时。
- Trace 经敏感信息脱敏后写入 Supabase，并投影到 Langfuse/OTel observation。
- 前端 Trace UI 展示时间线和上下文段；Usage API 聚合请求级成本。
- Eval 分为确定性 mock、可选 live、RAG routing、groundedness、Langfuse dataset 和在线 scores。

### 项目亮点与边界

- **亮点**：能回答“Agent 为什么这样做”，而不只是记录最终答案。
- **亮点**：离线 Eval 与线上代理指标分开，避免把线上无标签指标当准确率。
- **边界**：默认测试仍会受真实 Redis 环境影响；生产 Route、SSE 生命周期和 Scheduler 并发测试不足。

### 面试题

#### Q1. Log、Trace、Metric 和 Eval 有什么区别？

**回答要点**：Log 是离散事件；Trace 还原单次 Run 因果链；Metric 做低基数聚合和告警；Eval 用有标签 case 判断质量。四者互补，不能用 Trace 数量替代准确率。

#### Q2. Agent Trace 至少应该记录什么？

**回答要点**：run/request/session/user关联、模型和工具步骤、输入摘要、工具参数与结果摘要、耗时、usage、预算、上下文决策、stop reason、错误和终态。敏感原文要脱敏或按权限存储。

#### Q3. Mock Eval 和 Live Eval 为什么要分开？

**回答要点**：Mock Eval 稳定验证编排、预算和工具协议，适合 PR；Live Eval 验证真实模型行为但有成本和随机性，适合 nightly。二者不能互相替代。

#### Q4. 线上没有标准答案，如何发现质量下降？

**回答要点**：完成率、工具错误率、重试率、groundedness、citation precision、no-result、延迟、Token、费用、用户反馈和改问率；它们是代理指标，发现异常后仍需回收失败 Trace 进入离线标注集。

#### Q5. 如何建立 Agent 发布门禁？

**回答要点**：PR 跑类型检查、确定性 Runtime/Routing 回归；nightly 跑真实模型和真实检索；按任务类别设置成功率、工具选择、引用、延迟和成本阈值；失败输出 Trace diff，并保留人工审批和回滚版本。

#### Q6. Trace 本身有哪些安全风险？

**回答要点**：可能泄露用户输入、工具参数、检索原文和密钥；需要最小采集、字段级脱敏、用户隔离、保留期、删除链路和审计。Metrics label 不能放 query/userId 等高基数字段。

---

## 十一、Scheduler 与后台任务

### 功能总结

- Scheduled Job 支持单次 `runAt` 和带时区的 Cron。
- Redis ZSET 保存到期索引，Supabase 保存任务定义、运行状态和执行历史。
- Handler 支持 reminder、LeetCode Daily 和复用 Agent Runtime 的 agent-task。
- Cron Route 使用 timing-safe secret 校验；失败任务5分钟后重试，周期任务成功后计算下一次时间。
- RAG ingestion 使用另一套数据库 lease queue，体现不同可靠性级别的任务模型。

### 项目亮点与边界

- **亮点**：把 Agent 从被动对话扩展为主动执行能力。
- **边界**：当前 ZSET 的 `ZRANGEBYSCORE + ZREM` 不是原子领取，并发 worker 可能重复执行；删除后崩溃也可能丢任务。
- **边界**：Webhook URL 需要补充与 `web_fetch` 同等级的 SSRF 防护。

### 面试题

#### Q1. 为什么任务定义放数据库、到期索引放 Redis？

**回答要点**：数据库作为持久真相源和审计记录；Redis ZSET 适合按时间低延迟扫描。双存储带来一致性问题，需要重建索引、幂等和补偿机制。

#### Q2. 如何原子领取到期任务？

**回答要点**：Redis Lua 原子查询并移动到 processing 集合，或用数据库 `FOR UPDATE SKIP LOCKED`/lease；任务记录 workerId、leaseUntil 和 attempt，超时后可重新领取。

#### Q3. Scheduler 如何保证 Exactly Once？

**回答要点**：分布式系统通常只能做到 at-least-once delivery + 幂等副作用。使用 jobId/runSlot 作为幂等键，副作用写入和 run record 建唯一约束；不能只依赖队列不重复投递。

#### Q4. Cron 时区和夏令时有哪些坑？

**回答要点**：Cron 解释必须携带 IANA timezone；DST 可能出现不存在或重复的本地时间；任务需要记录预期 run slot，避免简单使用服务器本地时间。

#### Q5. 为什么后台 Agent Task 不能简单复用聊天全部工具？

**回答要点**：无人值守场景无法实时确认，副作用风险更高。应使用专用 allowlist、预算、超时、幂等、凭证范围和通知策略，不能因为复用了 Runtime 就默认权限相同。

---

## 十二、认证、多租户与运行时配置

### 功能总结

- 服务端同时支持 Supabase Cookie Session 和兼容性的 Bearer Token。
- 用户 API 调用 `requireUser`；服务端 service role 查询仍显式追加 `user_id`。
- 前端 Supabase 查询依赖登录用户和 RLS，服务端高权限客户端只存在于后端。
- 运行时配置使用注册表白名单；配置值用 AES-256-GCM 加密，密钥来自环境变量。
- 只有 `CONFIG_ADMIN_EMAILS` 中的账号能修改配置；修改记录 actor 和 value digest 审计。

### 项目亮点与边界

- **亮点**：认证和租户隔离贯穿知识库、会话、Trace、记忆和调度。
- **边界**：Service Role 绕过 RLS，任何漏写 `user_id` 的查询都可能成为越权问题，必须测试而不是依赖代码习惯。

### 面试题

#### Q1. Authentication 和 Authorization 有什么区别？

**回答要点**：认证确认“你是谁”；授权确认“你能操作什么资源”。`requireUser` 只完成第一步，查询仍必须按 userId、管理员角色或资源所有权过滤。

#### Q2. 使用 Supabase Service Role 有什么风险？

**回答要点**：它绕过 RLS，适合受控后端任务，但应用层漏条件会直接跨租户。应封装 tenant-scoped repository、加入越权测试、最小化使用范围并审计高权限操作。

#### Q3. 为什么运行时配置要同时加密和审计？

**回答要点**：加密保护静态数据，审计回答谁在何时修改了哪个配置；digest 用于判断值是否变化但不暴露明文。主密钥不能和数据库密文放在同一信任域。

#### Q4. Cookie 和 Bearer Token 同时支持会有什么问题？

**回答要点**：身份来源优先级、CSRF、Token 撤销和日志脱敏更复杂。项目优先 Cookie，失败后兼容 Bearer；生产需要明确迁移终点和每类客户端的安全策略。

#### Q5. 如何验证多租户真的隔离？

**回答要点**：构造两个用户，对每个读写/删除/API/RPC/缓存/Artifact/Trace 做交叉访问矩阵；既测试 RLS，也测试 service-role 路径和缓存 key，不能只看表里有 `user_id`。

---

## 十三、数据库、部署与运维

### 功能总结

- Supabase/PostgreSQL 保存会话、消息、记忆、知识索引、Trace、任务、配置和运行记录；pgvector 提供语义召回。
- Redis/Upstash 承担会话缓存、Scheduler 到期索引等低延迟状态。
- Docker 使用多阶段构建和非 root 用户，Next.js 输出 standalone。
- Nginx 为 `/api/chat` 关闭 buffering/cache 并延长读取超时，以支持 SSE。
- Artifact 使用挂载卷保存，脚本按 TTL 和总容量清理；Trace/RAG 运行数据也有清理脚本。

### 项目亮点与边界

- **亮点**：已经考虑生产构建、长连接代理、数据保留和非 root 容器。
- **边界**：本地 Artifact Volume 只适合单节点；多实例需要对象存储或共享存储。
- **边界**：异步写入和队列交付尚未形成统一 outbox/worker 架构。

### 面试题

#### Q1. 为什么 Next.js SSE 部署时要关闭 Nginx buffering？

**回答要点**：代理缓冲会攒够数据才发送，前端看不到实时 delta；还需要较长 read timeout、禁用 cache，并确保上游正确处理客户端断开。

#### Q2. 为什么本地文件 Artifact 不适合多实例？

**回答要点**：请求可能被路由到不同实例，另一个实例读不到文件；滚动发布和容灾也会丢失。对象存储应以 userId/scopeId 做逻辑隔离，使用短期签名访问并设置生命周期。

#### Q3. 如何设计可靠的异步记忆沉淀？

**回答要点**：聊天事务内写 outbox event；worker 原子领取、重试和死信；以 requestId/session turn 做幂等；写入成功后更新事件状态。不能依赖 HTTP 返回后仍有进程时间。

#### Q4. 数据库迁移如何做到可回滚？

**回答要点**：采用 expand-and-contract：先加兼容字段/表，双读或双写，回填验证，再切换读路径，最后删除旧结构；向量索引用版本化影子表和 active version 切换。

#### Q5. 这个项目上线后最先建立哪些 SLO？

**回答要点**：聊天成功率和首 Token/p95 完成延迟；工具错误率；检索成功与 no-result 分布；任务准时率和重复率；记忆写入成功率；每请求 Token/成本。SLO 必须绑定明确 Run 终态。

---

## 十四、综合架构题

#### Q1. 这个项目最有价值的三个设计是什么？

**回答要点**：可回答为：受控 Agent Runtime、Agentic RAG 证据闭环、可审计 Context/Trace。然后分别说明它们解决循环失控、幻觉和不可排障问题。

#### Q2. 当前最需要修复的三个问题是什么？

**回答要点**：确认协议绑定；Scheduler 原子领取和幂等；异步持久化 outbox。安全方向还应补 DNS 解析级 SSRF 防护和后台 Webhook URL 校验。

#### Q3. 如果从单用户扩展到企业多租户，优先改什么？

**回答要点**：组织/工作空间权限模型、tenant-scoped repository、配额与成本、密钥隔离、审计、数据保留、异步队列、多实例 Artifact、SLO 和生产回归，而不是先增加更多工具。

#### Q4. 如果让你把系统拆成服务，怎么划分？

**回答要点**：先按一致性和扩缩容边界，而不是按文件夹机械拆分：Chat/Run Control、Tool Worker、Knowledge Ingestion/Retrieval、Memory Consolidation、Scheduler、Observability。早期可保持模块化单体，只把长耗时和需可靠重试的任务异步化。

#### Q5. 如何证明这个项目不是“功能堆砌”？

**回答要点**：用一条生产请求展示各模块的数据契约和共同 Run/Trace；用 Eval 证明路由、工具、检索和回答质量；说明每个机制针对的失败模式、指标和取舍。

---

## 十五、备考建议

1. 先熟练讲清项目总链路，控制在2分钟内。
2. 重点准备 Agent Runtime、RAG、Context、Memory、Tool Safety 和 Eval 六个模块。
3. 每个模块至少准备一个真实故障或边界，不要只讲理想设计。
4. 回答中明确区分“当前已实现”“测试验证过”“下一步设计”。
5. 面试前从 Trace 页面挑2至3次真实 Run，练习按时间线复盘。

### 一句话总结

> 这个项目的核心价值，是把不确定的模型行为放进一个有上下文预算、工具权限、证据校验、人机协作和可观测终态的工程系统中。
