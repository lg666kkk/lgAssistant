# Agent 记忆系统面试题库（结合当前项目代码）

> 以面试官视角整理，按真实面试节奏逐层深入：概念分层 → 写入与生命周期 → 召回与上下文 → 安全隐私 → 可靠性 → 评测观测 → 代码深挖 → 生产故障与演进。
> 每题给出「想听」「项目落点」或「追问」。回答时应区分已实现能力、工程取舍和待完善项，不把路线图当作当前事实。
> 核心代码：`lib/agent/memory/`、`app/api/chat/route.ts`；设计说明：[layered-memory.md](../agent/memory/layered-memory.md)；SQL：`docs/schemas/*memories*.sql`。

---

## 当前模块功能总结

本项目的记忆不是一个向量库，而是三类运行时能力和一条受控生命周期：

```text
会话连续性：有 session 时优先 ContextSnapshot
    → 客户端已带完整历史则直接使用 client
    → 仅有当前消息时 Redis List(2h sliding TTL) → PostgreSQL messages fallback
    → 无 session 时使用 client

长期召回：当前问题 → 规则门控 → query embedding → pgvector 候选
    → active/confidence 过滤 → relevance + importance + recency 重排
    → top-k → 不可信 memory-data 段 → Prompt Pipe

记忆沉淀：完整本轮 transcript → LLM 候选抽取 → 结构/证据/敏感信息校验
    → exact key + semantic candidates → ADD/UPDATE/INVALIDATE/NOOP
    → embedding → PostgreSQL RPC 原子双写长期表和语义索引

显式忘记：用户命令 → 同步候选定位 → 确定匹配或保守决策
    → 两表原子软失效 → 可信的操作结果段
```

面试时必须主动说明以下边界：

- 工作记忆就是当前 `messages` 和 `ContextPlan`，不属于 `MemoryStore`；会话恢复负责连续性，长期记忆负责跨会话个性化，两者不是一回事。
- `agent_memories` 与 `agent_semantic_memories` 当前保存同一事实的两份物理表示：前者按业务 key 管理，后者按向量召回；不能把它们描述成两套独立认知记忆。
- 当前已有可信证据、敏感信息拒写、冲突决策、软失效、原子双写和租户过滤，但普通沉淀仍是请求结束后的 fire-and-forget，没有持久任务、重试、幂等事件和 DLQ。
- 召回先经过正则规则门控，只对显式记忆、偏好、画像和延续类问题启用；它节省成本和噪声，但存在同义表达漏召回。
- 召回重排是固定权重 `0.75 * similarity + 0.15 * importance + 0.1 * recency`，不是学习排序器；recency 使用 90 天半衰期。
- 记忆被标记为 `external` 并作为不可信 JSON 数据注入 system prompt，降低 Prompt Injection 风险，但这不是完整的数据治理、隐私合规和策略执行系统。
- 服务端 Supabase 客户端使用 service role，因此安全性仍依赖每条查询和 RPC 都正确携带、强制过滤 `user_id`；RLS 不能替代应用层检查，应用层检查也不能替代数据库约束。
- 当前测试覆盖策略函数、存储闭环、原子写入参数和聚合观测，但没有独立的 memory golden set、端到端质量门禁、持久 worker 故障恢复和大规模召回评测。

---

## 使用方式

每题先练 60-90 秒主回答，再接受追问。项目题建议固定使用五段结构：

1. **先定义目标**：记忆要改善什么体验，不能只说“存得更多”。
2. **讲真实链路**：从当前代码入口讲到存储、召回、注入或失效。
3. **解释取舍**：质量、延迟、成本、隐私和可靠性如何平衡。
4. **承认边界**：明确规则、异步任务和双表模型的局限。
5. **给验证方法**：用 extraction precision、decision accuracy、Recall@K、contradiction rate、forget success rate、延迟和成本验证。

---

## 第一层：概念与架构（判断是否真正理解记忆）

### Q1. Agent 记忆和上下文窗口有什么区别？

- **想听**：上下文是本次推理直接可见的临时状态；记忆是跨轮或跨会话保存、检索、治理后再进入上下文的数据。存下来不等于模型记住，只有被正确召回并注入才会影响回答。
- **项目落点**：工作记忆由 `messages`、`ContextPlan` 和 Snapshot 管理；跨会话事实由 `memory-flow.ts` 召回后作为独立 Prompt Segment 注入。

### Q2. 为什么要分工作、会话、长期和语义记忆？

- **想听**：分层依据应是寿命和访问模式。工作层按 token 管理；会话层按有序日志读取；长期层按稳定 key 管理；语义索引按相似度召回。
- **追问**：语义记忆是一种内容类型还是一种检索方式？本项目更接近后者。

### Q3. 讲一下本项目一次完整的记忆读写闭环。

- **回答思路**：请求先恢复会话上下文；对最后一条用户消息执行显式忘记和召回；召回结果进入 Prompt Pipe；Agent 完成回答后把完整 transcript 交给 `consolidate()`；抽取候选经过证据校验、写入决策，再由 `MemoryWriter` 原子写入两张表。
- **信号**：必须说清读路径在推理前、普通写路径在完整回答后，显式忘记则同步处理。

### Q4. 长期记忆和知识库 RAG 都用 embedding + pgvector，为什么不能合并？

- **想听**：数据来源、写入权限、生命周期、可信度、召回时机和删除语义不同。知识库是显式摄取的文档证据，通常由工具按需检索；记忆来自对话沉淀，包含用户画像和偏好，需冲突决策并主动或受控注入。
- **项目落点**：`SemanticStore` 和 `RAGRetriever` 分开，记忆召回进入 memory segment，RAG 进入 EvidenceBundle 和引用校验链路。

### Q5. `agent_memories` 和 `agent_semantic_memories` 是两种记忆吗？

- **想听**：不是。当前它们是同一 canonical fact 的 key-value 表示和向量索引表示。双表便于不同访问模式，但产生一致性和迁移成本。
- **追问**：更成熟的设计可否单表加 embedding？可以，但要结合稀疏列、索引、更新频率和查询隔离权衡；也可 canonical table + 派生索引/outbox。

### Q6. 为什么 `SessionStore` 不继承 `MemoryStore`？

- **想听**：接口隔离。会话是 `append/getHistory/clear` 的有序列表；长期事实是 `set/get/list/invalidate/forget` 的 key-value 模型。强行统一会产生无意义接口或错误语义。

### Q7. “记住所有对话”为什么不是好记忆系统？

- **想听**：全量保存会增加隐私风险、检索噪声、token 成本和错误固化。成熟系统要有选择性写入、来源证据、冲突处理、有效期、访问控制和遗忘机制。

### Q8. 项目中的 `MemoryType` 和 `MemoryLayer` 有什么区别？

- **想听**：Layer 表示存储/访问层，如 session、longterm、semantic；Type 表示事实语义，如 preference、profile、project、correction、episodic。类型不应直接决定存储介质。

---

## 第二层：写入、抽取与生命周期（核心能力）

### Q9. 什么信息值得写入长期记忆？

- **想听**：用户本人明确表达、跨会话仍有价值、未来能改善回答的信息；拒绝一次性任务、助手推断、临时状态和秘密凭据。
- **项目落点**：抽取 prompt 要求用户事实，最多 8 条；`parseExtractedFacts()` 校验长度、key、type、source、置信度、原文证据和敏感模式。

### Q10. 为什么 LLM 抽取结果不能直接写数据库？

- **想听**：模型输出是不可信候选，可能格式错误、伪造证据、抽错主体、包含秘密或与旧事实冲突。需要确定性 schema 校验、policy、candidate retrieval 和 write decision。
- **项目落点**：只有 `evidenceExcerpt` 能逐字回指用户消息且通过 restricted pattern 的候选才进入决策。

### Q11. 原文证据为什么重要？它能完全保证事实正确吗？

- **想听**：证据提供可审计的来源并限制模型凭空抽取，但只能证明“用户说过”，不能证明现实世界为真，也不能证明抽取后的第三人称改写没有语义偏差。
- **追问**：更严格时可保存 message ID、offset、hash 和版本，而不只保存 excerpt。

### Q12. `user_explicit` 和 `inferred` 应如何区别对待？

- **想听**：显式事实通常可给更高信任和更长寿命；推断应提高写入门槛、降低召回权重、允许用户确认，并更快衰减。当前项目接受两者，但尚未按 source 使用不同策略权重。

### Q13. `ADD/UPDATE/INVALIDATE/NOOP` 分别解决什么问题？

- **想听**：ADD 新主题，UPDATE 同主题的新版本，INVALIDATE 明确否定或忘记旧信息，NOOP 去重或拒绝低价值候选。它把“抽取”与“是否修改长期状态”拆开。

### Q14. 为什么先做确定性决策，再调用 LLM 决策？

- **想听**：同 key 新增、完全重复、已失效重激活等简单情况可稳定处理，减少成本和不确定性；只有相似但 key 不同、目标含糊的冲突才交给模型。
- **项目落点**：`deterministicWriteDecision()` 覆盖 exact-key 路径，`decideMemoryWrite()` 只处理剩余候选。

### Q15. 稳定业务 key 为什么重要？LLM 自己生成 key 有什么风险？

- **想听**：稳定 key 提供幂等、精确更新和冲突定位；模型 key 漂移会让同一事实出现多个版本。当前正则只约束格式，无法保证语义规范一致。
- **改进**：领域化 key taxonomy、实体解析、alias 映射，或由确定性代码生成 key。

### Q16. 为什么删除默认使用软失效，而不是物理删除？

- **想听**：软失效保留审计、冲突历史和恢复能力，同时 `match_memories` 只读 active；但用户的合规删除请求最终可能要求级联物理删除、备份清理和删除证明。

### Q17. 显式“忘记我喜欢香菜”为什么要同步执行？

- **想听**：这是用户直接要求的数据变更，不能像后台优化任务一样 best-effort。系统应在回答确认前知道目标是否已成功失效。
- **项目落点**：路由先调用 `handleExplicitForgetRequest()`，再把可信操作结果作为 `memory-operation` 段注入；含糊目标不猜测删除。

### Q18. 用户说“我以前住上海，现在住杭州”，如何避免两个事实都被召回？

- **想听**：需要同主题识别、UPDATE/INVALIDATE、有效区间和冲突状态。当前 exact key 可确定更新；key 漂移时依赖语义候选和 LLM 决策，仍可能漏掉冲突。

### Q19. `valid_from/valid_to/status` 解决了什么？当前是否是完整双时态模型？

- **想听**：它表达事实生效和失效区间，并从召回中排除无效记录；但当前没有独立 transaction time、历史版本表或每次变更事件，所以不是完整 bitemporal model。

### Q20. 为什么普通 `consolidate()` 要在最终回答和工具结果完成后执行？

- **想听**：完整 transcript 能看见本轮纠正和执行结果，避免只根据请求前消息沉淀错误状态。但工具证据只能辅助理解，不能替代用户原话成为用户事实。

---

## 第三层：召回、排序与上下文注入

### Q21. 为什么不是每个问题都召回长期记忆？

- **想听**：无关记忆会污染上下文、增加 embedding 延迟和隐私暴露。项目用规则门控只处理记忆、画像、偏好、延续和个性化意图。
- **边界**：正则精度高但召回率有限；“照老规矩来”一类未覆盖表达可能漏召回。

### Q22. 召回门控应该怎么评测？

- **想听**：建立 should-recall / should-not-recall 分类集，关注 recall、precision、false-negative 的业务损失和额外 embedding 成本；按语言、同义表达、多轮指代和敏感主题切片。

### Q23. 为什么先召回 `max(12, limit * 4)` 个候选，再只注入少量结果？

- **想听**：扩大候选池给治理过滤和重排留空间，最终 top-k 控制噪声与 token。候选倍数是启发式，应通过 Recall@K、注入准确率和延迟消融确定。

### Q24. 当前记忆排序公式如何解释？

- **项目落点**：`0.75 * semantic similarity + 0.15 * importance + 0.1 * recency`，先过滤非 active、置信度低于 0.5 或无 score 的记录；recency 是 90 天半衰期指数衰减。
- **边界**：固定权重未校准，不同类型和来源共用一套权重，importance 还是模型生成值。

### Q25. `confidence`、`importance`、`similarity` 为什么不能混为一谈？

- **想听**：confidence 是事实/抽取可信度，importance 是未来价值，similarity 是与当前 query 的相关程度。高置信的无关事实不该召回，高相似的低置信推断也不该直接使用。

### Q26. 为什么读取后要更新 `last_accessed_at`？会有什么副作用？

- **想听**：它支持 recency、热度和淘汰策略；但每次读都写会形成写放大和热点竞争，异步 touch 失败也会导致排序漂移。可批量、采样或异步聚合访问事件。

### Q27. 当前纯向量召回在哪些场景会失败？

- **想听**：姓名、ID、错误码、日期、精确数字和短 key 可能语义区分不足；同义近义也可能召回错误实体。可加入 exact key、结构化过滤、keyword/BM25 和实体索引形成 hybrid recall。

### Q28. 记忆如何进入 Prompt？为什么不能直接拼一段自然语言？

- **想听**：应有独立 segment、来源、信任级别、优先级和 token budget。当前用 JSON 序列化并转义 `<>&`，明确声明 memory-data 不是指令，且当前用户陈述优先。

### Q29. 把记忆放进 system prompt 是否就可信了？

- **想听**：不会。system 位置提高了影响力，也放大污染风险。项目把 segment 标记为 `external`，但仍需 provenance、内容净化、策略隔离、最小注入和注入攻击评测。

### Q30. 当当前消息与召回记忆冲突时，模型应该信谁？

- **想听**：当前用户的明确陈述优先；同时应触发记忆更新或冲突标记，不能只在本轮 prompt 中临时覆盖。
- **项目落点**：render prompt 已写明当前消息优先，后台 consolidation 再负责 UPDATE/INVALIDATE。

### Q31. 记忆、RAG、历史消息和工具结果竞争 context window，怎么分配预算？

- **想听**：按任务相关性、可信度和不可替代性分段预算；保留当前任务和安全策略，限制记忆 top-k 和每段 token，工具大结果转 artifact，历史做压缩。
- **项目落点**：memory segment priority 90、budget 500；可信的 memory-operation priority 108、budget 220。

---

## 第四层：安全、隐私与多租户

### Q32. 对话记忆最主要的安全风险是什么？

- **想听**：敏感信息长期化、跨租户泄漏、Prompt Injection 持久化、错误画像、越权删除、日志二次泄漏和无法满足用户遗忘。

### Q33. 当前敏感信息过滤做了什么，还缺什么？

- **项目落点**：拒绝私钥块、API key/token/password 模式、13-19 位数字和身份证模式。
- **边界**：正则会误报漏报，未覆盖地址、健康、邮箱、变体编码和秘密分片。成熟方案需数据分类、地域/租户策略、DLP、加密和用户同意。

### Q34. 如何防止记忆型 Prompt Injection 变成持久后门？

- **想听**：写入时拒绝指令型内容或降级为数据，保存来源；读取时结构化转义、明确不可信、限制注入；执行工具前仍由独立 policy/approval 控制，不能相信记忆中的授权。

### Q35. `user_id` 过滤和 RLS 各解决什么问题？

- **想听**：应用/RPC 过滤表达业务作用域，RLS 是数据库最后防线。项目 service-role 客户端可绕过普通 RLS，因此所有查询必须显式 user filter，RPC 还应拒绝 null user ID 并限制执行权限。

### Q36. Redis 会话 key 为什么必须包含 `userId`？

- **想听**：`sessionId` 可能被猜测、复用或由客户端传入，单独使用会产生跨用户碰撞；当前 key 为 `session:{userId}:{sessionId}:messages`，测试也覆盖相同 sessionId 的用户隔离。

### Q37. 用户要求“删除我的所有记忆”，只软失效够吗？

- **想听**：产品级忘记可软失效；合规删除通常要求长期表、语义索引、Redis、消息、Snapshot、trace、缓存、备份和派生数据的一致删除，并提供完成状态和失败重试。

### Q38. 如何让用户知道系统记住了什么并进行纠正？

- **想听**：提供可查看、编辑、删除、禁止记忆、来源证据和作用范围的 UI/API；重要推断先确认。当前已有底层 list/forget/invalidate 能力，但没有完整用户治理界面和审计工作流。

---

## 第五层：可靠性、存储与分布式一致性

### Q39. 为什么长期表和语义表必须原子双写？

- **想听**：一边成功一边失败会导致精确读取与语义召回看到不同事实。当前两表在同一 Postgres，用一个 plpgsql RPC 最简单，任一步失败整体回滚。

### Q40. embedding 失败时会不会产生半写？

- **项目落点**：`MemoryWriter.upsert()` 先生成 embedding，再调用原子 RPC；embedding 失败发生在数据库写入前，RPC 内任一 SQL 失败则事务回滚。
- **追问**：模型调用成功但进程在 RPC 前崩溃怎么办？当前会丢失，需要持久任务和幂等重放。

### Q41. 为什么原子事务仍不能解决全部可靠性问题？

- **想听**：事务只保证一次数据库调用内部一致，不能保证后台任务一定执行、网络超时后的结果可判定、跨服务副作用、重试去重和死信恢复。

### Q42. 当前 fire-and-forget consolidation 有什么故障窗口？

- **想听**：Serverless 冻结/进程退出、网络失败、限流和部署切换会让任务丢失；错误只记录日志，用户请求已经成功，无法自动补偿。
- **改进**：提交 durable job，使用 `requestId/sessionId` 幂等，worker 重试、退避、DLQ、状态表和积压告警。

### Q43. `upsert(user_id,key)` 的幂等边界是什么？

- **想听**：相同 key 重放不会新增行，但可能覆盖时间、evidence 和内容；如果 LLM 生成不同 key，数据库幂等无效。还需稳定事件 ID 和版本/乐观锁避免旧任务覆盖新事实。

### Q44. 两个并发请求同时更新同一偏好会怎样？

- **想听**：当前 upsert 近似 last-write-wins，候选读取和最终写入之间存在竞态，旧请求可能后写覆盖新请求。可用 per-user/key 串行队列、版本号 CAS、advisory lock 或事件序列处理。

### Q45. Redis 2 小时滑动 TTL 的收益和风险是什么？

- **想听**：活跃会话持续保留，闲置会话自动释放；每次 append 刷新 TTL。风险包括超长活跃会话无限增长、Redis 不可用、JSON 损坏和全量 `LRANGE` 成本，需要长度上限、裁剪和 fallback。

### Q46. 项目如何恢复会话历史？这个顺序为什么重要？

- **项目落点**：优先 ContextSnapshot；否则若客户端已带完整历史则使用 client；只有单条当前消息时再查 Redis，Redis 空则回退 PostgreSQL messages 并回填 Redis。
- **边界**：多源可能版本不一致，需要 snapshot version、去重和明确 source 观测。

### Q47. embedding 模型或维度升级时，记忆系统怎么不停机迁移？

- **想听**：不能把新维度直接写入 `VECTOR(1024)`；应版本化列/表或影子索引，离线 backfill，双写或灰度读，质量验证后切换，最后清理旧索引。

---

## 第六层：评测与可观测（Senior 分水岭）

### Q48. 如何分层评测一个记忆系统？

- **想听**：写入层看 extraction precision/recall、evidence validity、sensitive rejection；决策层看 ADD/UPDATE/INVALIDATE/NOOP accuracy；召回层看 Recall@K/MRR/irrelevant injection；回答层看 personalization gain、contradiction 和 grounded use；运维层看延迟、成本、失败率和积压。

### Q49. 记忆评测集应该包含哪些 case？

- **想听**：显式偏好、隐式推断、一次性信息、秘密、同义 key、事实纠正、否定、忘记、含糊删除、跨语言、跨租户、时间变化、注入文本、无须召回问题和应召回但表达隐晦的问题。

### Q50. 如何证明记忆真的改善了回答，而不是让回答更“像个性化”？

- **想听**：同一任务做 memory on/off 对照，由事实正确性、任务成功率和用户偏好满足度评分；同时测过度个性化、错误引用旧偏好和隐私惊讶率。

### Q51. 当前 Trace 能看到什么，缺什么？

- **项目落点**：Langfuse 有 `memory.recall` 的 eligible/candidate/selected/type/source 聚合，`memory.consolidate` 有 extracted/persisted/invalidated/skipped/failed 和决策计数，不记录原文内容。
- **边界**：后台 span 生命周期依赖请求进程；缺 durable job correlation、逐阶段耗时、队列积压、模型/embedding 成本和质量标签闭环。

### Q52. 为什么观测日志不应该记录完整 memory content？

- **想听**：记忆通常是高敏感用户画像，完整日志会扩大访问面和保留周期。应记录 ID、类型、source、decision、数量、hash 和错误分类，内容仅在严格授权审计中短期查看。

### Q53. 线上应该为记忆系统设置哪些告警？

- **想听**：召回/写入错误率、consolidation 丢失或积压、embedding 延迟和限流、ADD/UPDATE 分布突变、敏感拒写率、forget 失败率、跨租户安全事件、两表一致性差异和注入 token 激增。

### Q54. 如何把 memory eval 变成发布门禁？

- **想听**：固定版本数据集和 judge rubric；关键安全 case 必须 100% 通过；质量指标设置相对基线和绝对下限；按语言/类型切片；保存模型、prompt、embedding 和 schema 版本；线上先 shadow/canary。

---

## 第七层：代码深挖与故障排查

### Q55. 为什么 `match_memories` 必须拒绝空 `filter_user_id`？

- **想听**：默认查全库是灾难性越权。SQL 使用 `filter_user_id IS NOT NULL AND user_id = filter_user_id` fail closed；TypeScript 缺 userId 也直接跳过。

### Q56. 为什么 `parseFirstJsonObject()` 仍不是理想的结构化输出方案？

- **想听**：它能从围栏或前后文本提取首个 JSON，但缺严格 schema、字段级错误报告和 provider 原生 constrained output。模型输出多个对象或语义非法仍需后置校验。

### Q57. 当前忘记请求为什么可能返回 ambiguous？

- **想听**：低阈值召回只能找候选，不能证明目标唯一；无强文本包含匹配时交给决策器。若模型不返回明确 INVALIDATE，系统选择不修改，避免误删。

### Q58. `LongTermStore.list()` 和 `get()` 对 status 的处理一致吗？

- **想听**：不完全一致。`get()` 按 key/user 读取，可能返回 invalidated；`list()` 当前没有显式 `.eq("status", "active")`，而 `SemanticStore.list()` 有。上层若把 list 当 active 清单会有语义风险，应统一契约或提供状态参数。

### Q59. 为什么 `touch()` 只更新语义表是一个值得讨论的设计点？

- **想听**：当前排序从语义表记录读取，所以功能上足够；但两份记录的 `last_accessed_at` 会漂移，长期表不再是完整 canonical view。若坚持双表等价，应原子 touch 或把访问统计独立成事件/聚合表。

### Q60. 为什么“迁移 SQL 已写好”不等于“线上能力已启用”？

- **想听**：代码依赖 RPC、列、约束和函数签名，只有目标数据库实际执行迁移并验证后能力才成立。面试中要说“代码和迁移已实现，部署状态需核实”，不能只凭仓库文件下结论。

### Q61. 测试里 Upstash DNS 失败应如何判断？

- **想听**：先区分业务断言回归和外部集成不可用。`ENOTFOUND` 是 DNS/基础设施问题；策略单测应使用 fake，真实 Redis/Supabase/embedding 测试应单独标成 integration，并由对应环境运行。

### Q62. 用户反馈“它总记不住我”，你如何排查？

- **排查顺序**：最终 transcript 是否进入 consolidation → 抽取是否成功 → 候选是否被证据/置信度/敏感规则拒绝 → decision 是否 NOOP → embedding/RPC 是否成功 → 数据库迁移是否部署 → 下一轮门控是否 eligible → recall 是否过阈值 → Prompt Pipe 是否保留 memory segment → 模型是否正确使用。

### Q63. 用户反馈“它记住了错误信息”，你如何排查？

- **排查顺序**：evidence 是否真来自 user → 抽取是否改写失真 → source/confidence 是否合理 → key 是否漂移 → 旧事实是否被 UPDATE/INVALIDATE → 召回是否注入多个冲突版本 → 当前消息覆盖规则是否生效。

### Q64. 给你两周提升这套记忆系统，你如何排优先级？

- **推荐答案**：第一周先建 memory golden set 和 deterministic fake，修复 list/status、canonical/access-time 语义并部署验证迁移；同时把 consolidation 改成 durable idempotent job。第二周扩召回门控与 hybrid recall、加入并发版本控制和用户查看/纠正/删除入口，再用离线 eval + shadow trace 验证。

---

## 第八层：进阶与前沿方向

### Q65. 什么时候需要 episodic、semantic、procedural memory 真正分库或分索引？

- **想听**：当它们的 schema、写入来源、召回特征、生命周期和权限明显不同才拆；只改一个 type 标签不等于形成了独立记忆能力。程序性经验还需要任务结果和策略验证，不能从用户一句话直接生成。

### Q66. Memory Graph 比向量列表多解决了什么？

- **想听**：实体关系、多跳依赖、时间演化和冲突谱系；代价是实体消歧、schema 演进和图一致性。用户偏好小规模时未必值得上图。

### Q67. 如何做 memory decay？“很久没访问”就应该删除吗？

- **想听**：衰减应结合类型、重要性、置信度、访问和有效期。身份/过敏信息不能仅因久未访问自动删除；低价值 inferred memory 可降权、归档或请求确认。删除与召回降权要分开。

### Q68. 记忆压缩和对话摘要有什么区别？

- **想听**：摘要保留一段会话的整体语境，记忆压缩把多条事实合并为可治理的长期状态。压缩必须保留 provenance、时间和冲突关系，否则会把不确定信息固化。

### Q69. 多 Agent 系统应该共享同一份记忆吗？

- **想听**：不应默认全共享。至少区分 user、workspace、agent、task/session scope；共享记忆要有写权限、来源身份、冲突策略和审计。否则一个 Agent 的推断会污染其他 Agent。

### Q70. 大模型上下文达到百万 token 后，长期记忆还有价值吗？

- **想听**：有。长上下文不解决跨会话持久化、权限、隐私、删除、时间有效性、选择性注意和成本。记忆系统的核心是受控状态管理，不只是弥补窗口长度。

---

## 项目证据索引

| 能力 | 当前代码/Schema | 面试表达 |
|---|---|---|
| 会话恢复优先级 | `app/api/chat/route.ts` 的 `resolveLoopMessages()` | Snapshot → client/Redis → PostgreSQL fallback，并回填 Redis |
| 会话存储 | `lib/agent/memory/session-store.ts` | Redis List，key 含 userId，2 小时滑动 TTL |
| 召回门控与重排 | `lib/agent/memory/memory-flow.ts` | 规则门控 + pgvector + relevance/importance/recency |
| 可信上下文 | `renderMemoryContext()`、`lib/agent/prompt/segments.ts` | 不可信 JSON 数据、转义、独立预算和 trust 标签 |
| 候选抽取 | `parseExtractedFacts()` | 原文证据、类型/来源/置信度校验、敏感信息拒写 |
| 写入决策 | `deterministicWriteDecision()`、`decideMemoryWrite()` | ADD/UPDATE/INVALIDATE/NOOP，确定性优先 |
| 显式忘记 | `handleExplicitForgetRequest()` | 同步、保守定位、含糊不删、原子软失效 |
| 原子双写 | `lib/agent/memory/atomic-writer.ts`、`20260718-atomic-memory-write.sql` | embedding 在事务前，两张表在同一 DB 事务内写入 |
| 生命周期字段 | `lib/agent/memory/types.ts`、`20260718-trusted-memory-lifecycle.sql` | type/source/confidence/importance/status/evidence/validity/access |
| 租户隔离 | store 的 userId 检查、`match_memories` | 应用层和 SQL 双重 fail closed；service role 是重要边界 |
| 可观测性 | `app/api/chat/route.ts` 的 memory observations | 只记聚合统计，不把记忆正文写入 trace |
| 测试 | `lib/agent/memory/*.test.ts` | 策略单测 + 外部集成闭环；尚缺独立 memory eval 门禁 |

---

## 一句话复习版

1. 记忆不是“把历史塞进向量库”，而是带选择、证据、冲突、权限和遗忘的长期状态管理。
2. 工作记忆、会话连续性、长期事实和语义索引按寿命与访问模式分工。
3. LLM 只产生候选，确定性校验和 `MemoryWriteDecision` 决定是否改变状态。
4. 两张记忆表是同一事实的 key-value 表示和向量索引，必须原子维护一致性。
5. 召回质量由门控、候选、阈值、排序、预算和最终使用共同决定。
6. 当前用户陈述优先于旧记忆，显式忘记必须同步、保守、可验证。
7. service role 下不能把 RLS 当万能保险，所有路径都必须显式携带租户作用域。
8. fire-and-forget 不是可靠后台任务，生产化需要持久队列、幂等、重试和 DLQ。
9. 记忆评测要拆成抽取、决策、召回、回答、安全和运维六层。
10. 面试中最有价值的是讲清已实现机制、真实边界、故障窗口和验证方法。
