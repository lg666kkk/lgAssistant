# Agent Harness 面试题库（结合当前项目代码）

> 以面试官视角整理，参考 [RAG 面试题库](./rag-interview-questions.md) 的分层方式，并结合当前项目的记忆、上下文、工具、规划、观测和评测实现。
> 每题给出「想听」「项目落点」「追问」或「边界」。回答时必须区分已经运行在生产路径中的机制和路线图能力。
> 核心入口：`app/api/chat/route.ts`、`lib/agent/runtime/index.ts`、`lib/agent/runtime/plan-execution.ts`、`lib/agent/tools/`、`lib/agent/context/`、`lib/agent/memory/`、`lib/agent/eval/`。

---

## 当前 Harness 功能总结

Harness 不是模型，也不是某个 SDK。在本项目中，它是包围模型的执行与治理系统：决定模型能看到什么、能调用什么、如何循环、何时暂停或停止、怎样验证结果，以及如何保存状态和观测运行。

```text
请求入口 /api/chat
  -> 鉴权、输入校验、会话恢复（Redis Snapshot -> Supabase Snapshot -> Redis History -> PostgreSQL）
  -> 记忆忘记/召回、RetrievalPlan、工具裁剪、Prompt Pipe、ContextPlan
  -> 复杂任务：生成 2-4 步计划 -> 用户审核 -> 按 allowedTools 顺序执行
     普通任务：直接进入 runAgentLoop
  -> 每轮：上下文压缩/预算检查 -> 模型调用 -> 工具策略与调度
     -> tool_result 回灌 -> 重复调用/检索预算/迭代上限保护
  -> 证据校验、最终流式回答、Session/Snapshot/Trace 持久化
  -> 完整 transcript 异步触发长期记忆 consolidation
  -> Mock/Live Eval 与 Langfuse/OTel 观测
```

面试时应主动说明以下边界：

- 当前没有独立的 `lib/agent/harness/` 实现；Harness 能力分散在 Route、Runtime、Plan、Tool Router、Context、Memory、Trace 和 Eval 中。
- AI SDK/模型 Provider 只负责模型调用和 schema 适配，不拥有 Agent Loop、工具执行权限、停止条件或业务状态。
- `runAgentLoop` 是单步反应式执行引擎，不是整个 Harness；`/api/chat` 才负责请求级恢复、检索、记忆、计划审批、SSE 和持久化。
- 多步骤任务采用受控 Plan-and-Execute：先展示计划等待用户确认，再逐步复用 `runAgentLoop`；它不是多 Agent 系统，也没有并行 DAG 调度。
- 工具已有风险等级、确认、超时、限流、并发组和成本元数据，但 `sandboxed`、`memoryLimitMb`、`requiresAuth` 等字段并未全部形成独立、可证明的运行时隔离。
- 本地 `AgentTrace` 从 `runAgentLoop` 或 `executePlan` 内开始，不能完整覆盖请求恢复、记忆召回、Prompt 装配和最终总结；Langfuse 根 observation 覆盖更外层，但两者尚未统一成 durable `AgentRun`。
- Eval 默认只有 mock 编排测试；live case 需 `EVAL_LIVE=1`。当前 runner 直接调用 `runAgentLoop`，不等于覆盖 `/api/chat` 生产边界。
- Replay/Diff/Report 和通用 `lib/agent/harness/*` 仍是路线图，不应作为已实现能力介绍。

---

## 使用方式

每题先练 60-90 秒主回答，再接受追问。推荐按下面五段表达：

1. **先定边界**：说明 Model、Agent Loop、Harness 和业务 Route 各自负责什么。
2. **讲真实链路**：从请求入口、上下文、模型、工具、停止条件讲到持久化。
3. **解释取舍**：质量、延迟、成本、安全、可恢复性如何平衡。
4. **承认缺口**：区分字段声明、实际 enforcement 和路线图设计。
5. **给验证方法**：用任务成功率、工具选择准确率、stopReason、预算、trace、replay diff 和线上 SLO 证明。

---

## 第一层：概念与边界（判断是否理解 Harness）

### Q1. Agent Harness 到底是什么？它和大模型是什么关系？

- **想听**：模型负责基于输入生成 token 或 tool call；Harness 是模型外层的确定性控制系统，负责上下文、工具、循环、权限、状态、验证、观测和停止。
- **项目落点**：模型调用经 Provider 完成，而 `route.ts`、`runAgentLoop()`、Tool Router、ContextPlan 和 Trace 共同构成 Harness。

### Q2. Harness、Agent Runtime、Orchestrator 三者有什么区别？

- **想听**：Harness 是总的执行环境；Runtime 是执行一个 Agent turn/loop 的核心；Orchestrator 负责选择执行路径、Agent 或步骤并协调状态。
- **项目落点**：`runAgentLoop` 更接近 Runtime，`/api/chat` 和 `executePlan` 承担部分 Orchestrator 职责，但当前没有独立多 Agent 控制器。

### Q3. 为什么不能把 `runAgentLoop` 直接等同于整个 Agent？

- **想听**：Loop 只处理模型与工具的反复交互；身份、会话恢复、记忆、检索路由、审批、最终响应和持久化都在它之外。
- **追问**：Scheduler 也复用 `runAgentLoop`，说明它是可复用执行内核，而不是 Chat 产品本身。

### Q4. AI SDK 或 Anthropic SDK 已经支持 tool calling，为什么还需要 Harness？

- **想听**：SDK 解决协议适配和模型调用，不决定工具是否有权执行、如何限流、怎样恢复会话、何时停止、如何评测或审计。
- **项目落点**：`ToolDefinition` 包含本地执行和风险策略，`jsonSchema` 只把参数 schema 适配给模型。

### Q5. 本项目是否已经有一个“通用 Harness 模块”？

- **想听**：没有独立成品模块，但生产路径已经具备分散的 Harness 能力。路线图中的 `lib/agent/harness/replay.ts`、`diff.ts`、`report.ts` 尚未落地。
- **信号**：能区分“架构能力存在”和“模块已经抽象完成”。

### Q6. 一个最小可用 Harness 至少要包含什么？

- **想听**：输入契约、上下文装配、模型调用、工具注册与执行、循环状态机、停止条件、错误边界和结构化运行记录。生产级还需审批、持久化、恢复、eval 和策略治理。

### Q7. Harness 的哪些决策应该由代码做，哪些可以交给模型？

- **想听**：意图理解、计划草案和工具参数可由模型生成；权限、预算、schema、租户隔离、重复保护、超时和最终状态转换必须由确定性代码控制。

### Q8. 为什么说 Harness 是 Agent 能力上限的重要组成，而不只是“胶水代码”？

- **想听**：同一模型在不同上下文、工具、反馈、验证和恢复机制下，任务成功率、安全性和长任务能力差异巨大；Harness 把概率生成变成受控执行。

---

## 第二层：请求编排与执行循环

### Q9. 讲一下本项目从 `POST /api/chat` 到最终回答的完整 Harness 链路。

- **回答思路**：鉴权/校验 -> 恢复上下文 -> 记忆与 RAG 路由 -> 工具裁剪 -> Prompt/ContextPlan -> 计划审批或直接 loop -> 工具执行 -> 证据校验 -> 最终流 -> Session/Snapshot/Trace -> consolidation。
- **信号**：不能从 `runAgentLoop` 开始，也不能在模型返回后就结束。

### Q10. `runAgentLoop` 每一轮做了什么？

- **想听**：压缩和预算检查、调用模型、解析文本/tool use、记录 usage/trace、执行工具、把 assistant tool_use 与 user tool_result 成对回灌，再进入下一轮。

### Q11. Harness 如何判断一次执行结束？

- **项目落点**：`stopReason` 区分 `completed`、`aborted`、`error`、等待用户/确认、`max_tokens`、预算超限、重复工具调用和最大迭代数。
- **追问**：业务完成与技术停止不是一回事，`completed=false` 也可能带有可展示的中间结果。

### Q12. 为什么同时需要最大迭代数、token budget 和重复工具调用保护？

- **想听**：三者防不同失控：迭代数限制循环长度，token budget 限制累计模型消耗，重复检测阻断相同动作死循环；单一限制无法覆盖全部情况。
- **项目落点**：Chat 入口传入 `maxToolIterations=8`，Runtime 还维护 128K 累计预算和 `seenToolCalls`。

### Q13. 重复工具调用应该如何判定？当前实现有什么取舍？

- **项目落点**：按 `{name,input}` 的 JSON 字符串判重，同一批次重复也会跳过。简单稳定，但对象键顺序、等价参数和本应重试的幂等读取可能被误判。
- **追问**：可用 canonical JSON、工具自定义 idempotency key 和带原因的 retry policy 改进。

### Q14. 用户中断请求时，Harness 应该传播哪些取消信号？

- **想听**：停止后续模型轮次、工具执行和 SSE 写入，并尽可能把 AbortSignal 传到 HTTP/DB 工具；还要记录 aborted 状态并避免后台副作用继续发生。
- **边界**：当前 `shouldStop()` 在多个阶段检查，但并非所有工具都接收统一 AbortSignal。

### Q15. 为什么工具结果必须以规范的 `tool_result` 回灌，而不是拼成普通文本？

- **想听**：保持 provider 协议中的 tool_use/tool_result 关联、调用 ID 和错误语义，避免模型把执行结果误解为用户指令。

### Q16. 最后一轮为什么还需要单独的 `streamModelResponse`？

- **项目落点**：计划步骤或异常停止后，Route 可能基于累积消息与证据生成用户可读的最终答复。该调用位于本地 loop trace 之外，是当前观测边界缺口之一。

---

## 第三层：上下文、记忆与状态管理

### Q17. 上下文管理为什么属于 Harness，而不是 Prompt Engineering 的小细节？

- **想听**：Harness 决定模型实际看到的状态、来源、信任和预算；上下文缺失或污染会直接改变行为。Prompt 文案只是其中一部分。

### Q18. 本项目如何恢复会话状态？为什么要有明确优先级？

- **项目落点**：有 session 时只接受一条当前 user 消息；优先读取 Redis Snapshot Cache，未命中或故障时读 Supabase Snapshot 并回填；仍无 Snapshot 时查 Redis History，未命中再回退 PostgreSQL 并回填 History。无 session 时可以直接使用 client messages。
- **追问**：多源恢复需要版本、去重和 source trace，否则可能重放旧状态。

### Q19. `ContextPlan` 给 Harness 带来了什么？

- **想听**：把 history、prompt segments、tools、预算、来源和裁剪决定变成显式契约，使 Planner、Executor、Trace 和 Eval 能回答“模型看到了什么”。
- **边界**：实际模型仍接收渲染后的 system 字符串，ContextPlan 主要承担规划与可观测契约。

### Q20. 为什么工具列表也属于上下文预算？

- **想听**：工具描述和 schema 会占输入 token，并影响模型路由。工具越多不一定越强，还会增加误选与攻击面。
- **项目落点**：先按 RetrievalPlan 和用户意图裁剪，再进入 ContextPlan。

### Q21. 本项目何时触发上下文压缩？压缩时要保留什么？

- **项目落点**：Runtime 以模型窗口上限、触发比例和目标比例压缩中间历史，保留 primer 与最近消息；语义压缩失败可走确定性 fallback，并写 `context_compaction` trace。

### Q22. 为什么压缩摘要不能只追求更短？

- **想听**：必须保留用户目标、约束、决定、工具证据、未完成步骤和引用关系；过度压缩会破坏可执行状态，摘要还可能引入新事实。

### Q23. 记忆系统在 Harness 中处于什么位置？

- **想听**：记忆是 Harness 管理的跨会话状态源，不是 Harness 本身。Harness 决定何时召回、以什么信任级别注入、何时沉淀、发生冲突或忘记时如何治理。

### Q24. 为什么长期记忆不能直接拥有工具权限？

- **想听**：记忆可能过时、错误或被注入。它只能作为不可信数据影响推理，真正的执行许可必须由 Tool Policy、当前用户确认和租户上下文决定。

### Q25. 记忆召回失败时，Harness 应该 fail-open 还是 fail-closed？

- **想听**：个性化召回通常可 fail-open，跳过记忆继续回答；显式忘记、合规删除或依赖记忆才能执行的关键动作应 fail-closed 并明确告知。
- **项目落点**：普通 recall 失败会跳过注入，显式忘记单独同步处理。

### Q26. 为什么 consolidation 要使用完整执行 transcript？

- **想听**：最终回答、工具结果和用户纠正决定事实是否成立；只看请求前消息会漏掉新证据或写入已被否定的状态。
- **边界**：当前普通 consolidation 仍是 fire-and-forget，进程退出时可能丢失。

### Q27. ContextSnapshot、Session History 和长期记忆分别解决什么问题？

- **想听**：Snapshot 保存可继续推理的压缩运行状态；Session History 保存短期对话连续性；长期记忆保存跨会话的选择性用户事实。三者生命周期、恢复语义和删除要求不同。

### Q28. 多 Agent 系统扩展后，Harness 应如何划分记忆作用域？

- **想听**：至少区分 user、workspace、agent、task/session，读取和写入分别授权；共享事实需要 provenance、冲突策略和审计，不能让一个 specialist 的推断默认污染全局。

---

## 第四层：工具治理、权限与调度

### Q29. Tool Registry、Tool Schema 和 Tool Router 分别负责什么？

- **想听**：Registry 管定义与查找；Schema 告诉模型参数契约；Router/Executor 在服务端落实存在性、风险、确认、限流、超时和执行上下文。

### Q30. 为什么“模型没有选择危险工具”不能算安全控制？

- **想听**：模型会被注入、误判或越权诱导。危险工具必须由代码拒绝，副作用工具必须有确认和最小权限，不能依赖 prompt 自律。

### Q31. 当前工具风险模型如何工作？

- **项目落点**：`safe` 可执行，`confirm` 未批准时返回 `pending_confirmation`，`dangerous` 或 runtime dangerous 直接阻断；Loop 识别确认状态并暂停。

### Q32. `requiresConfirmation` 字段和 `riskLevel="confirm"` 是否完全等价？

- **想听**：不应仅看类型声明。当前 Router 的实际确认判断主要基于 `riskLevel`，调度器会用 runtime 字段决定串行；两套信号若不统一会产生策略漂移。

### Q33. 工具并行执行的安全前提是什么？

- **想听**：只并行无副作用、safe、无需确认且同并发组允许的工具；写操作、危险操作和未知工具串行。还要保持结果按原调用顺序回灌。
- **项目落点**：Runtime 按 `concurrencyGroup/maxConcurrency` 分批并行，随后处理 serial 队列。

### Q34. 为什么写工具通常要串行？

- **想听**：避免顺序依赖、竞态、重复副作用和难以回滚。真正需要并行写时要有幂等键、事务或补偿语义，而不是只提高并发参数。

### Q35. Timeout、Rate Limit、Concurrency Limit 分别解决什么问题？

- **想听**：Timeout 限制单次挂起；Rate Limit 限制时间窗口内总调用；Concurrency Limit 限制同时占用资源。三者互补，且应按租户/工具作用域治理。

### Q36. 当前 in-memory rate limit 有什么生产边界？

- **想听**：只在单进程内有效，重启丢失，多实例各自计数，不能形成全局配额；生产应使用 Redis/网关或集中配额服务，并明确用户与工作区维度。

### Q37. 工具返回内容为什么要 shape、truncate 或转成 artifact？

- **想听**：防止大结果挤爆上下文，保留可用摘要，同时把完整内容放到受控存储按需读取。还要记录截断和 artifact ID，避免模型误以为看到全文。

### Q38. `sandboxed: true` 是否证明工具真的运行在沙箱里？

- **想听**：不能。策略字段只是意图，必须核验执行器是否创建了 OS/container 隔离、路径/网络策略和资源限制。当前通用 Router 没有证明这些 enforcement。

---

## 第五层：规划、审批与长任务

### Q39. ReAct 与 Plan-and-Execute 在 Harness 中如何配合？

- **项目落点**：普通任务直接 ReAct；启发式识别多步骤任务后生成 2-4 步计划，用户确认后逐步执行，每一步仍复用 `runAgentLoop`。

### Q40. 为什么计划必须经过 normalize 和 allowed-tools 校验？

- **想听**：Planner 输出不可信，可能引用不存在或越权工具。代码需限制步骤数量、字段长度、工具白名单和结构，再允许执行。

### Q41. 为什么本项目先展示计划再执行，而不是自动执行后再汇报？

- **想听**：让用户确认目标、步骤和副作用边界，避免模型错误分解造成连续动作；代价是多一次交互和更高延迟。

### Q42. 每个计划步骤为什么要限制 `allowedTools`？

- **想听**：缩小攻击面和选择空间，让步骤权限与目标绑定；即使模型在 prompt 中要求其他工具，也不会出现在该轮工具列表中。

### Q43. 当前计划的 success criteria 是如何验证的？有什么不足？

- **项目落点**：当前主要以 loop completed、没有失败工具且有非空输出判定 verified；并没有逐条语义验证 `successCriteria`。
- **改进**：确定性 artifact/assertion 优先，必要时用独立 verifier，并把证据与判定写入 trace。

### Q44. 计划步骤失败后应该重试、跳过还是停止？

- **想听**：取决于错误分类、幂等性、依赖关系和用户策略。当前执行遇到未验证步骤会停止；没有通用自动 retry/backoff/compensation 状态机。

### Q45. 为什么当前 Plan-and-Execute 不是多 Agent？

- **想听**：所有步骤共用同一个 Runtime、模型配置、会话和工具注册表，没有独立 AgentDefinition、身份、上下文或消息协议；它是单 Agent 的分步控制。

### Q46. 长任务要做到进程重启后继续执行，还缺什么？

- **想听**：持久 `AgentRun/StepRun` 状态、输入与产物引用、checkpoint、lease、幂等执行、重试/DLQ、版本固定和 resume API。当前 Snapshot 解决上下文连续性，不等于 durable workflow。

---

## 第六层：Trace、Eval 与 Replay

### Q47. Trace、Log、Metric、Eval 各回答什么问题？

- **想听**：Trace 还原一次运行的因果链；Log 记录离散事件；Metric 看群体趋势与 SLO；Eval 用固定任务和断言判断行为质量。四者不能互相替代。

### Q48. 当前 `AgentTrace` 记录了哪些 Harness 决策？

- **项目落点**：model、tool、context compaction、plan、retrieval、answer validation step，以及 usage、耗时、成本、stopReason 和 ContextPlan。

### Q49. 为什么当前本地 Trace 还不是完整 request trace？

- **想听**：它在 Runtime/Plan 内创建，外层的鉴权、历史恢复、记忆召回、Prompt 构建、最终总结和部分持久化不在同一结构化调用树中。

### Q50. 默认 mock eval 通过能证明什么，不能证明什么？

- **想听**：能证明确定性的 loop 编排、工具回灌和断言机制没有明显回归；不能证明真实模型会正确选工具、外部服务可用、Prompt 有效或生产 Route 正常。

### Q51. 为什么 eval runner 直接调用 `runAgentLoop` 是一个覆盖缺口？

- **想听**：绕过了 Route 的鉴权、会话恢复、记忆、RAG 路由、工具裁剪、计划审批、最终验证、SSE 和持久化。需要分层测试并增加 production-boundary case。

### Q52. Harness eval 应该包含哪些确定性断言？

- **想听**：工具名/参数、调用次数、顺序、allowed-tools、stopReason、预算、确认暂停、无危险副作用、ContextPlan 来源、trace step 顺序、记忆写入决策和持久化状态。

### Q53. LLM-as-judge 适合放在哪里？

- **想听**：用于回答质量、完整性、风格和证据使用等难以规则化的指标；不应替代权限、租户隔离、工具参数和状态转换等确定性断言，CI 中还需处理波动和成本。

### Q54. Replay Harness 的核心输入应该是什么？

- **想听**：版本化的原始请求、ContextPlan、模型/Prompt 配置、工具调用与可重放结果、记忆/RAG snapshot、随机性参数和原 trace；不能只拿最终文本再问一遍。

### Q55. 为什么本项目现在还不能宣称支持完整 replay？

- **想听**：虽然已有 Trace 和 Eval，但没有通用 capture/replay/diff/report 模块，外部工具结果和记忆状态也未全部快照化；路线图设计不等于运行能力。

### Q56. 两次 Harness 运行应该比较哪些维度？

- **想听**：任务成功、工具序列/参数、停止原因、token/成本/延迟、上下文裁剪、证据质量、记忆多写漏写、安全违规和最终答案变化；不能只做文本 diff。

---

## 第七层：可靠性、安全与故障排查

### Q57. Harness 中哪些失败应该降级，哪些必须阻断？

- **想听**：非关键观测、个性化召回可降级；鉴权、租户边界、危险工具审批、显式删除、必需证据和不可判定副作用应阻断。要按业务语义分类，不能统一 catch 后继续。

### Q58. 用户反馈“Agent 一直绕圈”，你如何排查？

- **排查顺序**：看 stopReason 和 model/tool trace -> tool result 是否提供可行动信息 -> 参数是否只做表面变化绕过判重 -> Prompt 是否要求继续 -> 上下文是否丢失完成状态 -> 预算和迭代保护是否生效。

### Q59. 用户反馈“工具明明失败，Agent 却说成功了”，你如何排查？

- **排查顺序**：ToolResult.ok/is_error -> tool_result 是否正确关联 call ID -> 截断摘要是否丢失错误 -> 后续模型是否忽略错误 -> plan verifier 是否只检查非空输出 -> 最终 answer guard 是否覆盖该任务。

### Q60. 用户确认了一个工具，为什么不能只把 `approved=true` 放进 prompt？

- **想听**：Prompt 不是授权凭证。确认必须绑定 user、request/toolCallId、工具名、参数摘要、过期时间和一次性消费，并在服务端执行点校验。
- **边界**：当前 pending confirmation 能暂停，但完整的持久 approval token/lifecycle 仍需加强。

### Q61. 如何防止 Prompt Injection 从 RAG 或记忆穿透到工具执行？

- **想听**：外部内容标记为不可信数据，最小化注入；工具白名单、schema、风险 policy 和审批独立于模型；敏感参数二次校验；trace 中记录来源与决策。

### Q62. Harness 如何处理“模型超时，但工具可能已经成功”的不确定状态？

- **想听**：副作用工具使用幂等键和操作记录，超时后先查询状态再决定重试；区分 at-most-once 与 at-least-once，必要时补偿。不能盲目再次执行。

### Q63. 为什么 fire-and-forget 的记忆沉淀和 Session 写入是可靠性风险？

- **想听**：请求返回或 serverless 冻结后任务可能丢失，错误只能日志记录，无法恢复。应使用 durable outbox/job、幂等消费、重试、DLQ 和积压告警。当前 Trace 收尾会 `await savePendingTrace()`，但保存失败仍按 best-effort 跳过，也需要明确审计可靠性目标。

### Q64. 给你两周提升这套 Harness，你如何排优先级？

- **推荐答案**：第一周统一 request-level `AgentRun` 和错误分类，补 `/api/chat` 生产边界 eval、审批 token 与工具策略 enforcement；第二周实现最小 replay/diff、持久 step checkpoint 和 durable memory/trace job，再用回归集与线上 shadow 验证。

---

## 项目证据索引

| Harness 能力 | 当前代码 | 面试表达 |
|---|---|---|
| 请求级编排 | `app/api/chat/route.ts` | 恢复、记忆、RAG、Prompt、计划、SSE、验证和持久化的总入口 |
| Agent Loop | `lib/agent/runtime/index.ts` | 模型/工具循环、预算、压缩、判重、停止原因和结构化事件 |
| 计划执行 | `lib/agent/runtime/plan-execution.ts` | 2-4 步受控计划、用户审核、每步工具白名单、顺序执行 |
| 上下文契约 | `lib/agent/context/plan.ts`、`types.ts` | 显式记录历史来源、Prompt segments、tools、预算和裁剪决定 |
| 工具治理 | `lib/agent/tools/types.ts`、`tool-router.ts` | 风险等级、确认、超时、限流、执行上下文；部分策略字段尚未 enforcement |
| 工具调度 | `executeToolUsesWithScheduler()` | 安全读取按并发组执行，写/危险/确认工具串行 |
| 记忆状态 | `lib/agent/memory/`、`route.ts` | 推理前召回、显式忘记、完整 transcript 后沉淀；普通写入仍 best-effort |
| 观测 | `lib/agent/runtime/trace.ts`、Langfuse/OTel | 本地 Agent 语义 trace + 外层 observation；尚未统一 durable AgentRun |
| Eval | `lib/agent/eval/`、`scripts/langfuse-eval.ts` | mock/live 分轨；当前核心 runner 绕过生产 Route |
| Replay | `docs/agent/roadmap/enterprise-agent-roadmap.md` | 只有设计目标，`lib/agent/harness/*` 尚未实现 |

---

## 一句话复习版

1. 模型负责生成，Harness 负责让生成在上下文、权限、预算和状态约束下可执行。
2. `runAgentLoop` 是执行内核，`/api/chat` 才是当前请求级编排入口。
3. SDK 提供模型协议，项目代码拥有工具权限、循环、停止与业务状态。
4. ContextPlan 让“模型看到了什么”成为可观测契约，Snapshot 让压缩状态可恢复。
5. 记忆是 Harness 管理的跨会话状态，不是授权来源，也不等于 Harness。
6. 计划是单 Agent 的受控分步执行，不是多 Agent；success criteria 仍缺语义验证。
7. 工具安全必须在服务端执行点 enforcement，策略字段和 prompt 声明都不等于隔离。
8. Trace 解释单次运行，Eval 防回归，Replay 比较新旧策略，三者职责不同。
9. mock loop eval 通过不等于真实模型、外部依赖或 `/api/chat` 生产链路通过。
10. 当前最关键的演进是统一 AgentRun、生产边界 eval、durable execution 和 replay/diff。
