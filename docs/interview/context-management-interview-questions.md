# Agent 上下文管理面试题库（结合当前项目代码）

> 以面试官视角整理，按真实面试节奏逐层深入：概念边界 -> 上下文来源与恢复 -> Prompt 组装与预算 -> 压缩与工具结果 -> Memory/RAG/Planning 协同 -> Snapshot 与可靠性 -> 安全、观测与评测 -> 生产故障与演进。
> 每题给出「想听」「项目落点」或「追问」。回答时应区分已实现能力、工程取舍和待完善项，不把设计文档或路线图当作当前事实。
> 核心代码：`app/api/chat/route.ts`、`lib/agent/context/`、`lib/agent/prompt/`、`lib/agent/runtime/compaction.ts`、`lib/agent/runtime/index.ts`；相关记忆题库：[memory-system-interview-questions.md](./memory-system-interview-questions.md)。

---

## 当前模块功能总结

本项目的上下文管理不是简单保留最近 N 轮，而是一条从多源恢复、选择、预算、压缩到持久化和观测的运行时链路：

```text
请求进入
  -> Redis ContextSnapshot Cache（优先）
  -> Supabase ContextSnapshot（未命中后回填 Redis）
  -> 客户端完整历史
  -> Redis Session History
  -> PostgreSQL messages fallback
  -> 当前 messages

当前问题
  -> 显式记忆操作 + 长期记忆召回 + RetrievalPlan
  -> Prompt Segment（priority / tokenBudget / source / trust）
  -> Prompt Pipe 分段硬预算与渲染
  -> ContextPlan 记录来源、选择、hash 和 Token 决策

Agent Runtime
  -> messages + system prompt + tool schemas 请求前估算
  -> 达到阈值后语义压缩，失败退回确定性摘要
  -> tool_use / tool_result 原子分组
  -> 大工具结果裁剪并落 Artifact，模型只看摘要和 artifact_id
  -> 累计 Token Budget + 输出预留阻止失控循环

请求完成
  -> ContextSnapshot 版本化保存压缩后的 messages
  -> ContextPlan / context_compaction / usage 写入 Trace
  -> 完整执行证据再进入长期记忆 consolidation
```

面试时必须主动说明以下边界：

- 上下文管理决定“本次模型调用能看到什么”；长期记忆负责跨会话保存和召回。记忆只有被召回并注入后，才成为当前上下文的一部分。
- `ContextPlan` 已记录 Prompt Segment、历史和工具 schema 的 Token、信任级别与内容 hash，但目前主要是决策快照和审计契约；它没有统一裁剪历史、工具 schema 和所有动态工具结果，因此不能描述成完整全局 Context Optimizer。
- Prompt Pipe 对 system segments 执行单段和全局硬预算，当前聊天路由传入 4200 tokens；对话历史与工具 schema 由 Runtime 的模型请求估算、压缩和累计预算控制，是另一层预算机制。
- Runtime 累计预算为 128k tokens，每次模型调用预留 4096 输出 tokens；压缩窗口最多按 80k 计算，60% 触发、目标压到 30%。这些是当前工程常量，不是所有模型的通用最优值。
- 压缩保留开场 primer、最近消息、已有摘要、Artifact/URL，并把 `tool_use + tool_result` 作为原子组；语义压缩失败时退回确定性摘要。但摘要仍可能遗漏事实，当前没有独立的 Context Golden Set 或事实保真发布门禁。
- Snapshot 按 `user_id + session_id` 唯一、版本递增并保存 content hash；保存失败只记录错误，不阻断已经完成的回答，也没有 CAS 防止并发请求旧版本覆盖新版本。
- 大工具结果可以落到本地 Artifact 并按用户/会话作用域读取，但本地文件存储不适合多实例；Snapshot 只保留引用，不等于 Artifact 与 Snapshot 具备统一生命周期。
- Plan-and-Execute 和普通 Agent Loop 共用同一个 `ContextPlan`，步骤结果会继续追加到 `loopMessages`；这解决了 Planner/Executor 基线一致性，但尚未实现每一步重新选择全部上下文或独立步骤预算。

---

## 使用方式

每题先练 60-90 秒主回答，再接受 2-3 个追问。项目题建议固定使用五段结构：

1. **定义目标**：上下文管理要提升任务完成率，而不只是避免超长报错。
2. **讲真实链路**：从来源、选择、预算讲到模型请求和持久化。
3. **解释取舍**：质量、延迟、成本、可靠性和安全如何平衡。
4. **承认边界**：明确当前记录能力与真正执行能力的差别。
5. **给验证方法**：用事实保留率、任务成功率、压缩率、延迟、Token、成本和恢复成功率验证。

---

## 第一层：概念与架构

### Q1. 什么是 Agent 上下文管理？它和“把聊天记录传给模型”有什么区别？

- **想听**：上下文管理是对 system policy、当前任务、历史、记忆、检索证据、工具 schema、工具结果和执行状态进行选择、排序、压缩、隔离与审计。聊天记录只是其中一种来源。
- **项目落点**：`buildPromptPipe()` 管 system segments，`resolveLoopMessages()` 管历史恢复，Runtime 再管理压缩、工具结果和累计预算。

### Q2. Context、Memory、RAG 三者的边界是什么？

- **想听**：Context 是本次推理可见输入；Memory 是跨轮/跨会话的持久事实；RAG 是从外部知识源按问题检索证据。Memory 和 RAG 都要经过选择后才能进入 Context。
- **追问**：长上下文模型出现后为什么仍需要 Memory 和 RAG？因为容量不等于相关性、时效性、权限、可验证性和成本可控。

### Q3. 为什么上下文窗口很大，仍然不能把所有内容都塞进去？

- **想听**：输入成本和延迟增加，噪声干扰、指令冲突、lost in the middle、隐私暴露和 Prompt Injection 面扩大；工具循环还会重复支付历史 Token。

### Q4. 上下文管理的核心目标是压缩率吗？

- **想听**：不是。核心是给定预算下最大化任务所需信息的保真度和可执行性。高压缩率但丢失约束、失败原因或工具证据，反而降低成功率。

### Q5. 什么是 Context Engineering？它和 Prompt Engineering 有什么区别？

- **想听**：Prompt Engineering 主要设计指令表达；Context Engineering 还治理数据来源、状态、检索、工具输出、预算、生命周期和观测。前者关注“怎么说”，后者关注“模型此刻看见什么以及为什么”。

### Q6. 为什么 Context Manager 更像控制面，而不是字符串拼接工具？

- **想听**：它需要根据模型窗口、任务阶段、信任、成本和依赖关系做决策，并产出可重放的选择记录；字符串拼接只是最终渲染步骤。
- **项目落点**：`ContextPlan` 是控制面契约的雏形，Prompt Pipe 和 Runtime 是部分执行面。

### Q7. 一次 Agent 请求里有哪些 Token 预算？

- **想听**：模型单次窗口预算、system prompt 分段预算、历史预算、工具 schema、单个工具结果、预留输出、整个 Agent Loop 累计预算，以及可能独立的检索/压缩模型预算。

### Q8. 为什么“保留最近 N 轮”不是成熟的上下文策略？

- **想听**：消息数量不等于 Token，也不等于价值；早期约束、计划目标或失败证据可能比近期寒暄重要。成熟策略应基于语义角色、依赖关系、信任和任务状态。

---

## 第二层：上下文来源与会话恢复

### Q9. 讲一下本项目恢复对话上下文的优先级。

- **项目落点**：有 session 时先读 Redis `ContextSnapshot` Cache，未命中或 Redis 故障时读 Supabase Snapshot 并回填缓存；没有 Snapshot 且客户端已带多条历史时使用 client；只有当前消息时读 Redis Session History，仍为空再回退 PostgreSQL messages 并回填 History；无 session 直接使用 client。

### Q10. 为什么 Snapshot 优先于 Redis History 和数据库消息？

- **想听**：Snapshot 保存的是 Runtime 已选择或压缩后的执行上下文，可直接延续摘要和 Artifact 引用；原始消息日志用于审计与重建，两者职责不同。
- **边界**：Redis 中结构损坏或跨 scope 的 Snapshot 会被删除并回退 Supabase，但当前仍未比较 `policyVersion/contentHash` 判断语义新鲜度。

### Q11. 为什么客户端带完整历史时不再和 Redis 合并？

- **想听**：避免重复消息、顺序冲突和多源合并的不确定性。必须定义一个权威来源，而不是把所有来源盲目拼接。
- **追问**：客户端历史能否完全信任？不能；需要用户归属、长度、角色和内容校验，服务端状态不应由客户端越权覆盖。

### Q12. 为什么只有一条当前消息时才回退 Redis/数据库？

- **项目落点**：这对应前端只发送本轮消息、服务端负责恢复历史的协议；若请求已经携带多轮历史，当前实现把 client 视为完整上下文。
- **风险**：协议没有显式 `historyMode/version`，调用方误传两条不完整消息时会跳过服务端恢复。

### Q13. 当前消息如何避免和 Snapshot 或数据库末尾重复？

- **项目落点**：Snapshot 路径比较最后一条消息的 role/content；数据库路径过滤末尾与当前用户内容相同的消息，再追加当前请求。
- **边界**：纯内容比较不是稳定 message ID；相同文本的真实重复提问可能被误判。

### Q14. Redis Snapshot、Redis History 和 PostgreSQL 消息日志分别承担什么职责？

- **想听**：Redis Snapshot KV 缓存模型可直接使用的执行上下文，Redis List 保存短期消息连续性；Supabase Snapshot 和 PostgreSQL messages 分别持久化执行上下文与用户可见记录。缓存丢失不应等于会话丢失，但数据库恢复会增加延迟。

### Q15. 为什么数据库恢复后要回填 Redis？

- **想听**：避免后续每轮都访问数据库，恢复热缓存；但回填必须保持用户隔离、顺序和 TTL，并防止并发请求互相 clear/append。

### Q16. 多源上下文如何处理一致性，而不是只定义读取顺序？

- **想听**：为消息、Snapshot 和客户端携带版本/游标；比较 last message ID、snapshot version/content hash；定义冲突策略和重建流程，并把选中的 source/version 写入 Trace。

---

## 第三层：Prompt 分段、信任与预算

### Q17. 为什么把 system prompt 拆成 Prompt Segment？

- **想听**：不同来源需要独立 priority、token budget、trust、更新频率和观测；分段后才能选择、裁剪、缓存和审计，而不是维护一个不可解释的大字符串。

### Q18. 当前 Prompt Segment 有哪些关键字段？

- **项目落点**：`kind/title/content/priority/tokenBudget/source/trust/dynamic/metadata`。其中 `source` 表示来源，`trust` 表示安全语义，`priority` 决定预算选择顺序，`dynamic` 可辅助稳定前缀设计。

### Q19. `source` 和 `trust` 为什么不能合成一个字段？

- **想听**：来源描述从哪里来，信任描述允许怎样使用。同为 runtime 来源可能有可信状态，也可能封装外部工具数据；同为 memory 来源也不能自动拥有指令权限。

### Q20. 当前 Segment 优先级如何体现业务语义？

- **项目落点**：显式记忆操作 108、身份 100、证据策略 97、RetrievalPlan 96、检索内容 95、长期记忆 90，其他搜索策略更低。硬预算不足时高优先级先保留。
- **边界**：这些数值是人工策略，尚未按任务类型动态调整，也没有离线消融证明最优。

### Q21. 为什么当前用户原文不应该复制进 system prompt？

- **想听**：复制会提高用户文本的指令优先级、重复付 Token，并让来源审计失真。用户输入应保持 `user` role；system 只描述如何处理当前任务。
- **项目落点**：测试明确验证 `buildPromptPipe()` 不把 `userMessage` 写入 system segments。

### Q22. 单段预算和全局预算为什么都需要？

- **想听**：单段预算防止一个来源垄断；全局预算保证所有段加上分隔符后仍不超额。只有全局预算可能让长记忆挤掉其他段，只有单段预算又无法约束总和。

### Q23. Prompt Pipe 如何执行硬预算？

- **项目落点**：按 priority 排序，先用 tokenizer 强制单段截断，再按剩余全局额度二次截断或省略，连 `\n\n` 分隔符也计入；最后恢复稳定渲染顺序并输出 decisions。

### Q24. 为什么预算选择顺序和最终渲染顺序可以不同？

- **想听**：选择顺序服务于资源竞争，渲染顺序服务于 Prompt 语义和稳定前缀。当前代码先按优先级选，再把稳定段放在动态段前并按 kind 顺序渲染。

### Q25. Prefix Cache 对上下文布局有什么要求？

- **想听**：稳定且高复用的 system/tool 前缀放前面，动态任务和检索内容放后面；无意义的日期、随机顺序或每轮变化字段会破坏 cache hit。安全正确性优先于缓存命中。

### Q26. 当前 `ContextPlan` 记录了什么，又没有做什么？

- **项目落点**：它记录 policy/model/window/output reserve、history source、各来源的 trust/priority/Token/decision/hash，以及 system/history/tool schema totals；不保存段原文以降低敏感泄露。
- **边界**：当前 plan 不负责统一执行历史裁剪、工具 schema 选择或跨步骤重规划，`totalTokens` 超窗口时也不会由 plan 自身阻断请求。

---

## 第四层：压缩、工具结果与 Artifact

### Q27. 什么时候应该压缩上下文？

- **想听**：根据真实 Token 与模型窗口比例触发，并保留输出空间和工具循环余量；还要避免每新增一条消息就重新摘要。当前常规阈值为最多 80k 窗口的 60%，目标 30%，至少新增 8 条消息才再次常规压缩。

### Q28. 为什么项目同时有常规压缩和强制压缩？

- **项目落点**：常规压缩控制上下文体积；如果累计 Agent Loop Token Budget 无法承担下一次请求加 4096 输出预留，则强制压缩绕过阈值和频率限制，再判断是否停止。

### Q29. 压缩为什么要保留 primer 和最近完整消息？

- **想听**：primer 保留初始目标/关键约束，最近消息保留当前局部状态；中间演进最适合摘要。只保留最近消息会丢目标，只保留摘要又会损失当前细节。

### Q30. 为什么 `tool_use` 和对应 `tool_result` 必须原子处理？

- **想听**：拆开会产生孤儿结果或缺失调用，破坏 provider 消息协议，也让模型无法理解结果属于哪个操作。
- **项目落点**：`groupMessagesForCompaction()` 检测相邻 matching ID 并作为一个 group 切分。

### Q31. 二次压缩为什么比第一次压缩更危险？

- **想听**：摘要再次被摘要会累积信息损失、错误和措辞漂移。必须识别已有摘要、保留重要约束/未完成项，并通过事实保真测试限制递归退化。
- **项目落点**：`[context-summary:v1]` 标记使旧摘要进入 digest 时不再按普通消息的短字符规则处理。

### Q32. 语义压缩失败时应该怎样降级？

- **项目落点**：`compactLoopMessagesSemantic()` 捕获空结果或模型错误，退回确定性结构化摘要，并把 `method/compressionModel/fallbackReason` 写入结果和 Trace。
- **追问**：为什么不能失败后直接使用超长原文？这可能让下一次模型调用超过窗口或累计预算。

### Q33. 确定性摘要和 LLM 语义摘要各有什么取舍？

- **想听**：确定性方案便宜、稳定、可测试，但理解能力弱；LLM 摘要能提炼状态与约束，但增加延迟、成本、幻觉和故障依赖。成熟系统常用结构化提取 + 语义摘要 + 原文引用。

### Q34. 工具结果为什么不能原样全部回灌模型？

- **想听**：网页、搜索和知识库结果可能非常大、重复且不可信，会迅速占满上下文并放大注入风险。应先 shape、裁剪、保留来源与完整产物引用。

### Q35. 当前不同工具结果如何分配 Token？

- **项目落点**：`read_tool_artifact` 最多 4000；`search_notes` 使用 RAG context 配置换算；普通或已 shape 的工具结果通常 1200；保存 Artifact 后给模型的摘要再限制为 800。

### Q36. Artifact 模式解决了什么问题？

- **想听**：把“完整执行产物的持久引用”和“模型当前需要的短摘要”分开。模型可在需要时用 `artifact_id` 再读取，避免每轮重复携带大结果。

### Q37. Artifact 模式有哪些新风险？

- **想听**：引用失效、跨用户越权、生命周期不一致、多实例本地文件不可见、磁盘增长、摘要与原文版本漂移，以及模型循环读取造成额外成本。

### Q38. 如何证明压缩没有破坏任务？

- **想听**：建立带初始约束、纠正、失败工具、Artifact、数字/ID 和长多轮状态的 Golden Set；比较压缩前后 constraint retention、fact recall、tool transaction integrity 和最终 task success，而不只比较 Token reduction。

---

## 第五层：Memory、RAG、Planning 与 Runtime 协同

### Q39. 长期记忆如何进入当前上下文？

- **项目落点**：最后一条用户消息先经过记忆召回门控和重排，结果作为 `source=memory/trust=external/priority=90/tokenBudget=500` 的独立 Segment 注入，而不是直接修改历史消息。

### Q40. 为什么显式记忆操作结果比召回记忆优先级更高、信任也不同？

- **想听**：操作结果是 Runtime 已执行状态，属于 trusted；召回事实来源于历史数据，可能过期或被污染，属于 external。当前忘记结果 priority 108，普通记忆 90。

### Q41. 记忆召回失败时，聊天请求应该失败吗？

- **项目落点**：当前捕获错误并跳过注入，属于可用性优先降级；Langfuse observation 标为 ERROR。
- **边界**：如果用户明确问“你记得我什么”，记忆是硬依赖，静默降级会产生错误语义，应让 Context/Retrieval 计划表达 required/optional。

### Q42. RAG 证据和长期记忆竞争上下文时，谁优先？

- **想听**：不能固定回答“RAG 永远优先”。当前任务事实和显式证据要求通常优先；个性化偏好在风格任务中可能更重要。应按任务、信任和不可替代性动态分配。
- **项目落点**：当前检索内容 priority 95、memory 90，是静态默认策略。

### Q43. RetrievalPlan 为什么也属于上下文？

- **想听**：它不是知识证据，而是 Runtime 给模型的受控决策状态，约束检索来源、原因、attempt 和 hard/soft evidence 行为。应标记 trusted/runtime，不能和外部检索内容混在一起。

### Q44. Plan-and-Execute 如何保持 Planner 与 Executor 的上下文一致？

- **项目落点**：路由先构建一次 Prompt、tools、RetrievalPlan 和 `ContextPlan`，创建计划与每一步 `runAgentLoop()` 都复用这组基础输入；Trace 也引用同一个 ContextPlan ID。

### Q45. 每个 Plan Step 是否应该看到完整历史？

- **想听**：不一定。步骤只需要目标、允许工具、完成标准、相关证据和必要的先前结果；全量历史会增加干扰。当前实现继续传递 `loopMessages`，并用 step system prompt 收窄任务，尚未做 step-level context selection。

### Q46. 为什么步骤结果要结构化，而不是只拼一段自然语言？

- **想听**：结构化状态能区分 completed/failed/skipped、产物引用、证据和失败原因，便于后续步骤选择、恢复和评测。当前 `PlanStepResultData` 已有状态与摘要，但上下文仍主要依赖文本传播。

---

## 第六层：Snapshot、持久化与并发可靠性

### Q47. `ContextSnapshot` 保存了哪些信息？

- **项目落点**：稳定 id、user/session、递增 version、model、policyVersion、summary、messages、artifactRefs、unresolvedItems、sourceMessageCount、contentHash 和时间戳。

### Q48. 为什么 Snapshot 需要 `policyVersion` 和 `model`？

- **想听**：不同模型窗口、tokenizer 和压缩策略可能产生不同有效上下文。版本字段支持审计、兼容判断和迁移，而不是把旧快照无条件交给新策略。
- **边界**：当前读取 Snapshot 时记录了这些字段，但没有执行兼容性校验或自动重建。

### Q49. `contentHash` 能解决什么，不能解决什么？

- **想听**：能检测内容是否变化、辅助幂等和审计；不能证明内容正确、顺序权威或没有并发覆盖，也不是访问控制。

### Q50. Snapshot 为什么在超过 24k 消息 Token 时还要再次压缩？

- **项目落点**：持久层不应无限保存 Runtime 的膨胀消息；创建 Snapshot 时强制压到目标比例，保留可恢复的紧凑状态。
- **边界**：这会形成 Runtime 压缩与 Snapshot 压缩两条路径，需要同一套保真测试和策略版本管理。

### Q51. 当前 Snapshot 保存有哪些故障窗口？

- **想听**：计划提案或最终回答完成后保存；失败只记录日志，用户已看到成功结果，下一轮可能恢复旧状态。异步 session message 保存和 Snapshot 保存也可能一边成功一边失败。

### Q52. 两个并发请求更新同一 session 的 Snapshot 会怎样？

- **项目落点**：数据库按 `user_id,session_id` upsert，但没有 `WHERE version = previousVersion` 的 CAS；较旧请求后完成时可能覆盖较新上下文。
- **改进**：乐观锁/version CAS、per-session 队列、turn sequence 或数据库 advisory lock，并对冲突做重试/合并。

### Q53. Snapshot 与原始消息日志如何设计灾难恢复？

- **想听**：原始日志是可重建事实源，Snapshot 是派生检查点；保存 lastEvent/turn ID 和策略版本，Snapshot 丢失或校验失败时从日志重放，再生成新版本。

---

## 第七层：安全、可观测与评测

### Q54. 上下文系统的主要安全风险有哪些？

- **想听**：跨租户混入、角色提升、持久 Prompt Injection、敏感数据进入 Trace/Snapshot/摘要、工具结果诱导副作用、Artifact 越权和删除链路不完整。

### Q55. 为什么检索内容和记忆即使放在 system prompt 里也不能视为可信指令？

- **想听**：消息 role 是传输位置，不是数据来源的信任证明。外部内容必须结构化标记为 data，安全策略和工具审批由独立 trusted policy 决定。

### Q56. ContextPlan 为什么只保存 hash，不保存每个来源的完整内容？

- **想听**：Plan 用于解释选择，不应复制敏感原文造成第二份泄露面；hash 可关联版本和判断变化。真正调试内容应采用受控、脱敏、限期的 Trace 展示。

### Q57. 当前 Trace 能观测哪些上下文决策？

- **项目落点**：Trace 保存 `contextPlan`；model step 带 `contextPlanId`、估算 Context Tokens、累计预算和 system segments；compaction step 带前后 Token、阈值、保留消息数、方法、模型与 fallback reason。

### Q58. 为什么只记录“发生了压缩”还不够？

- **想听**：还要记录触发原因、策略版本、来源选择、压缩前后 Token、事实/约束保留指标、后续任务结果和失败降级；否则无法判断压缩是优化还是质量事故。

### Q59. 上下文管理应该有哪些离线指标？

- **想听**：source selection precision/recall、constraint retention、fact retention、tool transaction integrity、snapshot replay success、压缩率、任务成功率、groundedness，以及分任务类型的 Token/成本/延迟。

### Q60. 线上应该监控哪些低基数指标？

- **想听**：history source 分布、Snapshot load/save failure、Prompt 段截断/省略率、压缩触发/降级率、before/after Token 桶、budget exceeded、Artifact 创建/读取失败和每 Run 总 Token。userId/query 不应作为 Metrics label。

### Q61. 如何构建 Context Golden Set？

- **想听**：从真实长对话和失败 Trace 采样，覆盖目标变更、否定纠正、早期硬约束、多工具事务、检索证据、跨轮 Artifact、并发恢复和 Prompt Injection；标注必须保留、可摘要和必须丢弃的信息。

### Q62. 如何做上下文策略的 A/B 或消融实验？

- **想听**：固定模型和任务集，分别关闭 semantic compaction、Artifact、memory injection、不同 primer/recent/阈值，比较任务成功、事实保留、groundedness、p95 延迟和 Token；不能只看平均成本。

---

## 第八层：生产故障、设计题与演进

### Q63. 用户反馈“它忘了我最开始的约束”，你如何排查？

- **回答思路**：按 source restore -> Prompt selection -> compaction -> Snapshot -> model attention 分层。看 Snapshot 是否是旧版本、约束是否在 primer/summary、是否被再次摘要截断、ContextPlan 是否保留、最终 model step 是否实际携带。

### Q64. 用户反馈“上下文没超窗口，但 Agent 很快停止了”，为什么？

- **想听**：单次模型窗口和整个 Agent Loop 累计 Token Budget 是两件事。每轮重复输入历史都会累计消费 128k run budget；下一次请求还要预留 4096 输出，强制压缩后仍不足就会 `token_budget_exceeded`。

### Q65. 用户反馈“工具明明成功，模型却说没结果”，你如何排查？

- **回答思路**：检查原始 tool result、shape/truncate、Artifact 保存、回灌的 `tool_result`、压缩时的 tool pair、摘要是否保留 artifact_id，以及 Plan Step 是否把结果传给后续步骤。

### Q66. Snapshot 有数据但恢复后回答倒退，可能是什么原因？

- **想听**：Snapshot 版本被并发覆盖、policy/model 不兼容、最后当前消息去重误判、摘要信息损失、Artifact 已清理、unresolvedItems 未维护，或客户端协议与服务端恢复规则不一致。

### Q67. 如何支持超长研究任务，而不是无限扩大 context window？

- **想听**：把对话、计划状态、证据、Artifact 和长期项目状态分离；工作集按步骤检索，完成项结构化落盘，按需读取原文；Context 只保留当前目标、依赖和必要证据。

### Q68. 多 Agent 系统应该共享同一个上下文吗？

- **想听**：共享完整 Transcript 会泄露权限并制造噪声。更合理的是每个 Agent 有独立工作集，Orchestrator 通过 typed handoff 传目标、证据、产物引用和权限；共享 Memory/Artifact 也要按 tenant/run/agent 做 ACL。

### Q69. 给你两周时间完善本项目上下文管理，如何排优先级？

- **回答思路**：先补 Context Golden Set 和压缩保真指标；再做 Snapshot CAS/恢复降级、统一 model-request hard budget 与 step-level context selection；随后统一 Artifact/Snapshot 生命周期和 durable state；最后用真实 Trace 校准优先级、阈值和成本。

### Q70. 大模型达到百万 Token 后，上下文管理还重要吗？

- **想听**：更重要。大窗口缓解容量，不解决相关性、注意力、信任、权限、时效、成本、延迟、状态一致性和可审计性。成熟 Agent 的竞争力来自把正确状态在正确阶段交给正确模型，而不是把所有数据堆进窗口。

---

## 代码定位速查

| 能力 | 当前代码 | 面试时重点 |
|---|---|---|
| 请求编排 | `app/api/chat/route.ts` | 历史恢复、记忆召回、Prompt、ContextPlan、Snapshot、Plan/Loop 共用入口 |
| ContextPlan | `lib/agent/context/plan.ts` | 来源、信任、Token、decision、hash；当前以审计契约为主 |
| ContextSnapshot | `lib/agent/context/snapshot-store.ts` | 版本、摘要、messages、Artifact 引用、24k 保存门槛 |
| 类型契约 | `lib/agent/context/types.ts` | ContextPlan/ContextSnapshot 与 source/trust/decision |
| Prompt Segment | `lib/agent/prompt/segments.ts` | priority、tokenBudget、source、trust、dynamic |
| Prompt 硬预算 | `lib/agent/prompt/budget.ts` | tokenizer 单段/全局预算和分隔符计数 |
| Prompt Pipe | `lib/agent/prompt/pipe.ts` | 选择顺序与渲染顺序分离 |
| Runtime 预算 | `lib/agent/runtime/budget.ts` | 请求估算、累计预算、工具结果截断 |
| 上下文压缩 | `lib/agent/runtime/compaction.ts` | 原子工具事务、递归摘要、semantic fallback |
| Agent Loop | `lib/agent/runtime/index.ts` | 60%/30% 压缩、强制 budget guard、Artifact、Trace |
| Plan 执行 | `lib/agent/runtime/plan-execution.ts` | 共享 ContextPlan、步骤收窄、结果传播 |
| Snapshot SQL | `docs/schemas/migrations/20260718-context-snapshots.sql` | user/session 唯一、RLS、版本字段 |
| 回归测试 | `lib/agent/context/context.test.ts` | 内容不落 Plan、Snapshot 版本 |
| 预算测试 | `lib/agent/prompt/budget.test.ts` | 单段/全局硬预算、不复制用户原文 |
| 压缩测试 | `lib/agent/runtime/compaction.test.ts` | tool pair、Artifact、重复压缩约束保留 |

---

## 一句话复习版

这套项目的上下文能力已经形成 **多源恢复 + Trust-aware Prompt Segment + Token 硬预算 + 语义/确定性双路径压缩 + 工具事务保真 + Artifact 引用 + ContextPlan/ContextSnapshot + Trace** 的完整骨架；面试时最重要的是既讲清这些已实现机制，也诚实指出 **ContextPlan 尚未统一执行所有来源预算、Snapshot 并发与失败恢复、步骤级上下文选择、Artifact 多实例存储和 Context Golden Set** 仍需继续工程化。
