# RAG 面试题库（面试官视角）

> 以面试官视角整理的 RAG 考察题库，按真实面试节奏逐层深入：概念动机 → 数据摄取 → 检索核心 → 工程生产化 → Agentic RAG → 评测调优 → 线上故障 → 前沿方向。
> 每题给出「回答思路」和「追问方向」。回答思路不是标准答案，而是帮助你按照“当前实现 → 设计原因 → 已知取舍 → 验证指标 → 下一步演进”组织表达。
> 项目对照：本项目的实现见 [rag-implementation.md](./rag-implementation.md)，检索代码在 `lib/knowledge/retriever.ts`，工具接入在 `lib/agent/tools/search-notes.ts`，评测脚本在 `scripts/rag-eval.ts`。

---

## 当前模块功能总结

本项目的 RAG 已经不是固定的“向量 TopK 后前置注入”，而是由离线摄取、在线路由、受控检索和答案校验组成的完整链路：

```text
离线：Notion → 结构/Token 感知切块 → 批量 Embedding 完整性校验
    → PostgreSQL 原子替换 → Index Snapshot / Rollback

在线：用户问题 → RetrievalAnchor / Standalone Query → RetrievalPlan
    → knowledge / web / both / no_retrieval 路由
    → Query Rewrite → Vector + Keyword 并行召回
    → RRF 或校准加权 → Rule/Cross-Encoder Rerank → Vector MMR
    → Evidence Grader → EvidenceBundle
    → Claim-level Citation / Groundedness Guard → Trace / Eval
```

当前实现中值得在面试时重点讲清的边界：

- `evidenceRequired=true` 表示用户明确要求私有知识或实时公开证据，检索失败时不能用模型参数知识伪装成已检索答案；知识画像软命中则允许降级。
- Knowledge Cache 按租户和索引版本隔离；Web Cache 不跟随私有知识索引版本失效，但按搜索深度隔离。
- Ingestion 使用数据库 lease、有限重试和 dead 状态；同一页面的文档替换通过数据库事务和 advisory lock 保证一致性。
- 最终回答已经执行基于 Evidence ID 的 Claim-level 检查，但当前支撑关系使用词面重叠启发式，不等于经过校准的 NLI/LLM Verifier。
- `web_fetch` 已限制协议、字面内网地址、重定向次数、响应大小和类型，但尚未做到 DNS 解析后 IP 校验，不能把它描述成完整 SSRF 防护。

---

## 使用方式

每题先练 60-90 秒主回答，再练 2-3 个追问。项目题不要只说“业界一般怎么做”，推荐固定使用下面的五段结构：

1. **先给结论**：一句话回答问题，不绕概念。
2. **说当前实现**：明确讲出项目里的模块、参数和真实数据流。
3. **解释取舍**：为什么先这样做，收益和代价分别是什么。
4. **承认缺口**：不要把规则 rerank 说成 Cross-Encoder，也不要把 6 条 eval case 说成成熟评测集。
5. **给验证方法**：用 Recall@K、MRR、no-result accuracy、groundedness、延迟和成本说明如何判断改动是否有效。

面试官真正判断的是：你是否理解系统为什么这样设计，能否发现它在生产环境中的边界，并知道如何用数据演进。

---

## 第一层：概念与动机（暖场，判断是背概念还是真理解）

### Q1. 为什么用 RAG 而不是微调？什么场景下微调反而更合适？

- **想听**：知识时效性、私有数据、成本、可溯源 vs 微调适合改变模型行为/风格/领域表达方式，而非注入事实。能说出「RAG 注入知识，微调注入能力」这个层次就过关。
- **追问**：两者能结合吗？（能，微调让模型更会用检索结果）

### Q2. 讲一下你项目里 RAG 的完整链路：从一条 Notion 笔记到出现在模型上下文里，中间经历了什么？

- **想听**：结构化的叙述能力。扫描 → 切块 → embedding → 入库 → 混合召回 → 融合 → rerank → MMR → 格式化注入。每一步能报出自己的参数（700 字符切块、0.7/0.3 融合权重）。
- **回答思路**：先区分离线索引链路和在线检索链路。离线是 Notion loader → 内容 hash/版本检查 → 标题感知分块 → `text-embedding-v4` 批量向量化 → Supabase `documents`；在线是 Agent 选择 `search_notes` → query rewrite → pgvector + Postgres FTS 并行召回 → 合并去重 → 规则 rerank → MMR → 工具结果整形后进入 Agent Loop。
- **信号**：这题答得流畅，面试官才会往深问；答得磕绊，说明项目不是自己做的。

---

## 第二层：检索核心（重头戏，必考）

### Q3. 为什么要做混合检索？向量检索什么时候会失效？

- **想听**：具体的失效案例，不是抽象的「语义 vs 字面」。比如报错码 `PGRST202`、函数名、人名 ID 这类 OOV 术语，embedding 区分度极差；关键词检索（BM25/FTS）正好互补。
- **追问**：两路分数怎么融合？加权求和有什么问题？（分数分布不可比——向量是余弦相似度，FTS 是 ts_rank，量纲不同。答出 RRF 倒数排名融合或归一化是加分项）

### Q4. 向量相似度高就等于这条结果有用吗？

- **想听**：不等于。bi-encoder 主要度量语义接近程度，不直接保证 chunk 能回答问题。「苹果发布会时间」和「苹果的营养价值」可能共享大量语义，但任务相关性完全不同。
- **项目落点**：当前项目不是 Cross-Encoder rerank，而是规则重排：融合分数基础上，完整 query 命中加 0.15、标题命中加 0.1。要明确说这是低成本第一版，不能冒充模型精排。
- **追问**：既然 cross-encoder 更准，为什么不直接用它检索全库？（O(n) 次前向推理算不动——所以是召回/精排两阶段架构，先粗筛再精排。答出这个说明懂搜索系统）

### Q5. 你的 chunk 是 700 字符，这个数怎么定的？切大切小各有什么问题？

- **想听**：诚实 + 权衡分析。太小语义不完整、上下文丢失；太大一个 chunk 混多个主题，embedding 被稀释、检索噪声大。最好答出「这个值应该由评测集调出来，而不是拍脑袋」。
- **追问**：chunk 脱离了文档上下文（如「它的优点是……」这种 chunk）检索不到怎么办？（embed 时前置标题路径 / contextual retrieval / parent-child 小块检索大块投喂）

### Q6. 用户的提问方式和文档的表述方式不一致怎么办？

例：用户问「怎么防止 Agent 瞎编」，文档里写的是「幻觉缓解策略」。

- **想听**：词汇鸿沟问题。query 改写、多 query 扩展、HyDE（先生成假想答案再检索）。
- **加分**：多轮对话里「那它呢」这种指代，经典 RAG 要专门做 query condensation；Agentic RAG 里模型生成工具调用参数时天然完成指代消解。

### Q7. 中文场景下做关键词检索，你踩过什么坑？

- **想听（本项目真实踩坑）**：Postgres FTS 的 `simple` 配置不分词中文，整句中文变成一个 token，keyword 路对中文形同虚设，只剩 LIKE 子串兜底；解法是 pg_jieba / zhparser 分词，或 bigram（二元组）索引 + 查询侧同样二元切分。
- **信号**：答出真实踩坑经历的候选人，可信度立刻上一个档次。

---

## 第三层：工程与生产化（区分 demo 选手和工程师）

### Q8. 知识库文档更新了，怎么保证索引跟着更新？全量重刷吗？

- **想听**：增量同步，content hash 判断内容变化。
- **关键加分点**：embedding 模型或切块算法升级了怎么办？——`content_hash + embedding_model + chunker_version` 三元组版本化（本项目 `lib/knowledge/sync.ts` 的做法），任一版本变了自动重建。
- **追问**：删除的页面怎么处理？同步到一半失败了索引处于什么状态？（项目已把页面 upsert、旧 chunk 删除和新 chunk 插入收进一个事务 RPC，失败整体回滚）

### Q9. 检索没有命中任何结果时，你的系统怎么办？

- **想听**：这是「诚实性」设计题。宁可返回「没找到」也不要降阈值硬塞——低相关内容进上下文，模型会基于噪声编造。
- **项目落点**：项目已移除 threshold=0 和降阈值兜底。显式 Query Planner 最多给出两条 query，两次都使用同一个全局阈值；Evidence Grader 根据分数、query coverage、双路召回一致性和 score gap 判断证据是否充分，不充分就明确返回无证据。query attempts、拒绝数量和 `thresholdFallback=false` 会写入 Trace。
- **Senior 信号**：主动讲出「给模型坏证据比不给证据更糟」。

### Q10. 多租户下怎么做数据隔离？向量检索层怎么保证 A 用户查不到 B 用户的笔记？

- **想听**：检索函数强制 user_id 过滤、RLS，以及「过滤在向量检索之前还是之后」（pre-filter vs post-filter——post-filter 会导致返回数量不足）。
- **项目落点**：当前向量和关键词 RPC 都接收 `filter_user_id`，查询时在 SQL `WHERE` 中过滤，属于 pre-filter；但服务端参数过滤不能替代 RLS，生产环境还要防止漏传 `userId` 或 service role 查询遗漏租户条件。

---

## 第四层：Agentic RAG（2025 之后的分水岭题）

### Q11. 把检索做成前置注入和做成 Agent 工具，有什么本质区别？你为什么选后者？

- **想听**：决策权转移——要不要查、查什么、查几次都交给模型；query 由模型生成，自带指代消解；检索从一锤子买卖变成可迭代过程（没查到换 query 重试）。
- **代价也要说**：多一次模型往返、延迟上升、模型可能该查不查。

### Q12. 模型怎么知道你的知识库里有什么、什么时候该调这个工具而不是 web search？

- **想听**：工具描述即路由器。静态描述写边界（「查不到公开实时信息」），进阶做法是动态生成知识库画像注入 tool description——本项目用 LLM 压缩 wiki summary 生成画像（`lib/agent/tools/knowledge-profile.ts`）。
- **追问**：画像每次请求都重新生成吗？（source hash 缓存 + 持久化，画像源没变就不重算）

### Q13. 长期记忆和知识库 RAG 技术栈几乎一样（embedding + 向量库），为什么要分成两套系统？

- **想听**：落到架构差异，而不是「语义上是两种东西」——写入路径不同（用户显式录入 vs Agent 对话沉淀）、生命周期不同、注入方式不同（工具按需调用 vs 主动注入 system prompt）、规模和粒度不同。
- **项目对照**：`SemanticStore`（记忆）与 `RAGRetriever`（知识库）分开实现。

### Q14. 检索结果、对话历史、记忆、工具输出都在抢 context window，你怎么分配？

- **想听**：上下文工程意识。预算与截断策略、来源标注格式（`[文档1] 标题 > 章节路径` 帮模型引用）、「top-k 不是越大越好」、lost in the middle 现象。

---

## 第五层：评测与调优（大多数候选人挂在这里）

### Q15. 你说加了 rerank/MMR 之后效果变好了——怎么证明？

- **想听（专治「感觉变好了」）**：golden set + 分层指标（检索层 Recall@k / MRR，生成层 groundedness / 引用准确率）+ ablation。
- **项目话术**：「我的 eval 脚本支持关闭 MMR、规则 rerank、query rewrite、multi-query vector 和 keyword，也能切换 RRF/weighted，并单独开启 Cross-Encoder，每项优化都可以做对照。」（`scripts/rag-eval.ts`）
- **边界说明**：数据集目前只有 6 条，现阶段只能验证评测管线和发现明显回归，不能证明统计意义上的普遍提升。
- **追问**：评测集怎么建的？多少条？怎么防止过拟合到评测集？

### Q16. 用户反馈「AI 引用的内容和原文对不上」，你怎么排查？

- **想听**：分层定位——是检索错了（召回的 chunk 就不对）还是生成错了（chunk 对但模型改写走样）？看 trace 里的检索 debug 信息（本项目 `search_notes` 的 metadata 带 ragTopResults，可直接定位）。

### Q17.（开放题收尾）给你两周时间优化这套 RAG，优先级怎么排，为什么？

- **没有标准答案，考判断力**。好回答的特征：先扩评测集再动检索（没有度量的优化是盲调）、每项改动说清预期收益和验证方式。

---

## 第六层：项目代码深挖（验证是不是你真正做过）

### Q18. 向量分数和关键词分数为什么不能直接按 0.7/0.3 相加？当前实现有什么风险？

- **回答思路**：两种分数来自不同分布，0.8 的 cosine similarity 和 0.8 的 keyword rank 不代表相同置信度；固定权重只在分数经过稳定校准后才有意义。项目现在默认使用 Weighted RRF，只依赖各召回列表中的排名，并让多 query/vector/keyword 的共识结果累积分数。
- **项目落点**：保留 `weighted` 作为消融策略；它先把原始分数与列表内 rank percentile 做轻量校准，再按 exact/semantic/multi-hop/balanced 动态分权。该校准仍是启发式，不是学习得到的概率校准。
- **取舍**：RRF 对异构分数更稳健，但会丢失绝对分差；第一名只比第二名高一点或高很多，在 RRF 中差别接近。因此仍要保留 score、gap 和 no-result 门控。
- **追问**：如何证明 RRF 比加权求和更好？（同一 golden set 做 ablation，比较 Recall@K、MRR、nDCG 和 no-result accuracy）

### Q19. 当前 Query Rewrite 和 Multi-query Vector 是怎么做的？

- **回答思路**：先用多轮上下文处理“那它呢”一类指代，再做确定性规则 rewrite：保留 standalone query、去掉问句包装、抽取错误码和技术术语，最多 3 个变体。所有变体一次批量 embedding、分别向量召回，再通过 RRF 合并；关键词路径也消费全部变体。
- **项目落点**：Runtime 会把当前用户问题之前的最近对话文本传给 `search_notes`；工具 schema 同时要求模型主动生成 standalone query。`--no-multi-query-vector` 可以退回“只有第一个变体走向量”的对照组。
- **风险**：规则 rewrite 可能产生高度重复的 query，也无法可靠解决复杂省略和实体歧义。若升级为 LLM rewrite，要评估额外延迟、query drift 和错误扩散。

### Q20. 为什么候选数量默认是 `topK * 4`，并且最多 50？

- **回答思路**：召回阶段需要比最终返回更多候选，给 rerank 和 MMR 留出纠错空间；候选太少无法重排，太多会增加数据库、网络和 CPU 成本。`*4/max50` 是工程启发式，不是理论最优值。
- **验证方法**：对 candidate multiplier 做 2/4/8 的消融，观察 Recall@K、MRR、延迟和内存；如果 Recall 不再增加就没有继续扩大的价值。

### Q21. 当前规则 rerank 具体做了什么？它会在哪些情况下失效？

- **回答思路**：RRF/校准加权先产生 base score；完整 query 出现在标题/路径/正文时规则加 0.15，标题包含 query 再加 0.1，最终限制到 1。它对精确术语和标题命中有效，但不能理解否定、时间、实体关系和“文档是否真正回答问题”。
- **项目落点**：规则版始终是快速路径。启用 Cross-Encoder 后，仅在 multi-hop、低 top score、小 score gap 或多来源排序冲突时处理前 12 个候选；失败会保留规则排序并把错误写入 Trace。
- **取舍**：条件触发控制成本，但触发规则本身也需要用困难 case 校准；不能因为接了 rerank provider 就默认质量一定提升。

### Q22. 当前 MMR 真的是向量 MMR 吗？`lambda=0.7` 如何解释？

- **回答思路**：相关性使用 rerank/combined score，多样性惩罚优先使用候选 embedding 的 cosine similarity；`lambda=0.7` 表示更偏相关性，0.3 用于惩罚语义重复。同一 `parent_key` 直接视为完全重复。
- **项目落点**：RPC 通过 `embedding_text` 返回候选向量；全部有向量时 Trace 标为 `vector`，部分有时为 `hybrid`，迁移未部署时自动降级到文本 Jaccard 的 `text` 模式。
- **取舍**：返回 embedding 增加数据库到应用的传输量。规模扩大后可只对较小候选池取向量，或在数据库侧完成多样性选择。
- **追问**：lambda 变成 1 或 0 会怎样？（1 退化为只看相关性；0 几乎只追求差异，可能返回不相关内容）

### Q23. 首次无结果后把阈值降到 0，有什么具体问题？你会怎么改？

- **回答思路**：阈值 0 会把“库里最像的内容”误当成“足够相关的内容”，尤其会破坏 no-result 问题；模型看到低质量证据后更容易产生有引用外观的幻觉。
- **改进方案**：设置二级阈值下限；增加 top1 绝对分数、top1-top2 gap 和规则 rerank 门槛；无结果时允许 Agent 改写 query 重试一次；仍不达标则返回没有证据。
- **项目落点**：当前是固定阈值、最多两条计划 query 和显式 Evidence Grader；Trace 记录 `queryAttempts`、`scoreGap`、`degradationReason` 和 `thresholdFallback`。后续仍应使用扩大的 no-result eval 校准 Grader，而不是把规则门槛视为永久常量。
- **验证指标**：no-result accuracy、误召回率、groundedness，而不只是 Recall@K。

### Q24. 为什么同步必须原子替换？当前项目是怎么实现的？

- **回答思路**：页面元数据、旧 chunks 和新 chunks 必须作为一个一致性单元；否则插入失败会留下 chunk_count 已更新但 documents 为空或不完整的状态。项目现在通过 `sync_notion_page_documents_atomic` RPC 在单个 PostgreSQL 事务内完成 upsert、delete、insert，任一步失败都会回滚。
- **项目落点**：RPC 强制 `userId`，使用事务级 advisory lock 串行化同一用户页面，并只授权 `service_role`；应用调用前还会校验向量数量、1024 维度和有限数。
- **后续演进**：超大页面或索引构建时间很长时，可改成带 `index_version` 的影子数据，校验完成后切换 active version，再异步清理旧版本。
- **追问**：为什么影子版本更适合大型索引？（构建时间长，无法长事务锁表，还能快速回滚）

### Q25. embedding 批量接口只返回部分向量或者顺序异常怎么办？

- **回答思路**：不能默认 `embeddings[i]` 永远对应 `chunks[i]`。至少检查返回数量，要求 provider index 是范围内的唯一整数并按 index 重排，同时拒绝空向量、非 1024 维、非有限数和零向量。部分返回和瞬时错误只重试当前批次，重试必须复用稳定幂等键；全部批次通过后才能替换旧索引。
- **项目落点**：`EmbeddingClient` 当前每批最多 10 条，每批最多重试 2 次（500ms 起指数退避），根据 `model + page/version scope + batch inputs` 生成确定性 `Idempotency-Key`。Trace 会记录批次、attempt、provider indexes、是否重排和失败原因；写库前 `buildAtomicDocumentPayload` 还会做第二次向量校验。
- **边界说明**：provider index 能发现乱序、缺失、重复和越界，但无法证明「provider 在正确 index 下返回了另一条文本的向量」；这需要 provider 自身契约或支持请求 item ID。`Idempotency-Key` 也只保证客户端重试身份稳定，是否去重计费取决于 provider 支持。
- **故障测试**：至少覆盖部分返回后成功、持续部分返回、乱序、重复/越界 index、401 不重试、维度错误、NaN/Infinity、空向量和零向量。

### Q26. embedding 模型从 1024 维升级到另一种维度，如何不停机迁移？

- **回答思路**：不能直接把新向量写进旧 `VECTOR(1024)`。应新建版本化向量列或新表，离线 backfill，双写或灰度查询，完成质量验证后切读路径，再清理旧索引。
- **项目落点**：项目已经保存 `embedding_model/chunker_version`，能识别需要重建；缺少的是多版本并存和切换机制。

### Q27. 引用为什么不能只给页面 URL？怎样做到可验证引用？

- **回答思路**：页面 URL 只能证明来源存在，不能证明某句话由哪个 chunk 支持。项目已有 `headingPath/startChar/endChar/chunk_index`，可以生成页面 + 标题路径 + chunk 的细粒度引用。
- **改进方向**：生成答案时要求每个事实绑定 source id；输出后做 citation entailment 检查；引用内容与当前文档版本 hash 绑定，避免页面更新后引用漂移。

### Q28. 如果知识库文档中包含 Prompt Injection，当前系统会怎样？

- **回答思路**：RAG 内容属于不可信数据，不应拥有指令权限。当前工具结果会作为 `tool_result` 回灌，但缺少统一的污点标记和“忽略文档内指令”策略，高风险工具场景仍需加固。
- **改进方案**：给外部/RAG 内容加结构化 trust label 和边界；system 明确声明只把内容当数据；读过不可信内容后调用副作用工具必须重新审批；建立 injection eval。

### Q29. 模型没有调用 `search_notes`，你如何判断是路由问题还是检索问题？

- **回答思路**：先看 Trace 是否出现工具调用。没调用是工具描述、知识库画像或模型路由问题；调用了但无结果是 query rewrite、阈值、索引或召回问题；结果正确但回答错误是 context construction/generation 问题。
- **项目落点**：知识库画像动态拼入 `search_notes` description，Trace 已记录工具步骤和 RAG debug；排障应该按 routing → retrieval → generation 分层，而不是直接调相似度阈值。

---

## 第七层：评测、可观测与生产化（Senior 分水岭）

### Q30. Recall@K、Precision@K、MRR、nDCG 分别回答什么问题？

- **回答思路**：Recall@K 看相关证据是否进入前 K；Precision@K 看返回结果中有多少相关；MRR 强调第一个正确结果的位置；nDCG 适合多个结果具有不同相关等级的排序质量。不能只报一个 pass rate。
- **项目落点**：当前脚本已有 Recall@K、MRR、二元 relevance 的 nDCG@K、关键词覆盖率、no-result accuracy 和平均延迟；尚缺 0/1/2/3 分级 relevance label，因此不能把当前 nDCG 当作多级相关性的完整评估。

### Q31. 如何构建一个可信的 RAG Golden Set？

- **回答思路**：从真实用户 query、知识库主题和失败 Trace 中采样；覆盖 direct/keyword/semantic/multi-hop/confusing/no-result；标注相关 page/chunk 和答案证据；保留困难负例；按训练调参集和最终测试集分离。
- **规模建议**：当前 6 条只能验证流程。第一阶段至少 30-50 条，稳定后扩到 100+，并按类别单独看指标，避免总分掩盖某类退化。

### Q32. 检索评测和端到端回答评测为什么必须分开？

- **回答思路**：检索正确但模型可能忽略证据；检索错误但模型可能靠参数知识碰巧答对。检索层看 source/chunk relevance 和排序，生成层看 correctness、faithfulness、citation precision、answer relevance 和拒答能力。
- **排障价值**：分层指标能告诉你应该改 retriever、context builder 还是 generation prompt。

### Q33. no-result case 怎么评估？为什么它和 Recall@K 同样重要？

- **回答思路**：no-result accuracy 衡量系统能否在没有证据时保持沉默；还应统计 false-positive retrieval rate 和错误引用率。只优化 Recall 会倾向于降低阈值，最终把任何问题都返回一些文档。
- **项目落点**：当前只有 1 条 no-result case，无法稳定调阈值，应补充未记录私密信息、库外知识、相似但不同实体、过期信息等困难负例。

### Q34. 线上 Trace 没有标准答案，还能监控什么？

- **回答思路**：线上只能监控代理指标：调用率、no-result 率、候选数、top score、score gap、vector/keyword 来源比例、fallback 率、延迟、用户点踩、引用点击和后续改问。它们能发现漂移，不能直接等同真实准确率。
- **项目落点**：Trace 页面展示 standalone/rewrite、query type、RRF/权重、各路候选、TopK、MMR 模式、Cross-Encoder 决策、阶段耗时、parent 去重、上下文 tokens 和 top results，并明确说明不能替代离线 Eval。

### Q35. 如何做 ablation，证明 Query Rewrite、Keyword、Rerank 和 MMR 各自有价值？

- **回答思路**：固定同一知识库快照、同一 golden set、同一 topK 和阈值，每次只关闭一个模块；比较总体和各 category 的 Recall@K、MRR、no-result accuracy、延迟。
- **项目落点**：`scripts/rag-eval.ts` 支持 `--no-query-rewrite`、`--no-multi-query-vector`、`--no-keyword`、`--no-rerank`、`--no-mmr`、`--fusion rrf|weighted` 和 `--cross-encoder`；下一步需要保存版本化基线报告并接入 CI 门禁。

### Q36. RAG 线上应该监控哪些指标和告警？

- **回答思路**：至少分四组：检索量与成功率、各阶段 p50/p95 延迟、质量代理指标、成本。重点告警包括 keyword RPC 降级、embedding provider 错误、no-result 率突增、top score 分布漂移、检索延迟和索引同步失败。
- **注意**：query/userId 不能作为 Metrics label，避免高基数；它们属于 Trace/Log。

### Q37. 用户说“引用内容和原文对不上”，完整排查顺序是什么？

- **回答思路**：先确认引用指向的文档版本；再检查检索到的原始 chunk；然后检查工具结果是否被截断或重排；最后看模型生成是否超出证据。结论要区分 retrieval error、context error、generation error 和 stale-source error。

### Q38. 知识库从一万 chunk 增长到一千万 chunk，哪些地方先出问题？

- **回答思路**：扫描和 embedding 成本、批处理限流、数据库写入、HNSW 索引体积和构建时间、pre-filter 查询效率、候选传输和重排延迟都会成为瓶颈。不能只说“加机器”。
- **项目落点**：当前 schema 使用 HNSW + cosine；大规模下需要评估租户分区、索引参数、异步 ingestion worker、批量 upsert、冷热数据和 embedding cache。

### Q39. 如何降低 RAG 延迟和成本，同时不明显损失质量？

- **回答思路**：缓存 query embedding 和稳定查询结果；并行向量/关键词召回；按 query 类型跳过不必要路径；控制 candidate 数和 rerank 成本；知识库未变化时复用画像；离线生成 chunk embedding；设置超时和可观测降级。
- **验证方法**：同时看质量指标与 p95 latency/cost per query，不能只优化平均延迟。

### Q40. 如果线上 no-result 率突然从 10% 变成 60%，你怎么处理？

- **回答思路**：先按时间关联发布、数据同步和 provider 变更；分阶段检查知识页/chunk 数量、embedding 维度、RPC 错误、阈值、query rewrite、用户过滤和索引健康；对比 vector/keyword 候选数确认哪一路断了。
- **止损措施**：回滚策略版本，禁用有问题的路径或切换已验证降级；不要直接把阈值降到 0 掩盖故障。

### Q41. 页面删除、用户删除和数据保留在 RAG 中怎么处理？

- **回答思路**：页面删除应级联删除 chunks 和引用；用户删除要清理 notion_pages、documents、知识库画像、缓存、评测样本中的敏感内容和外部观测数据；生产环境还要有保留期和删除审计。
- **项目落点**：数据库存在外键级联和 user_id，但完整删除链路还应覆盖 Redis/cache/Langfuse 等派生数据。

### Q42. 给你两周优化项目 RAG，你会怎么排期？

- **回答思路**：第 1-2 天扩 golden set 和基线；第 3-4 天校准受控 fallback 和融合/RRF；第 5-7 天补 query rewrite 实验；第 8-9 天评估 Cross-Encoder；第 10 天补 injection/multitenant 测试；剩余时间做 dashboard、回归和文档。同步原子性已经落地，应把时间用于验证失败回滚和并发同步。
- **原则**：先建立度量和修正确性风险，再追求更复杂模型；每项优化都要有前后数字和回滚方案。

### Q43. 你会如何把 RAG Eval 变成发布门禁？

- **回答思路**：固定版本化数据集和知识库快照；PR 跑确定性 retrieval eval；nightly 跑真实 embedding 和端到端 judge；与基线比较而不是只看绝对分；按类别设置阈值；输出失败 case 和 top results diff。
- **门禁示例**：Recall@5/MRR/no-result accuracy 任一退化超过阈值则阻断；p95 延迟或成本显著增长需要人工审批。

---

## 第八层：前沿方向（2025-2026 热点，用于拉开差距）

> 这一层不是必答题，而是加分题。面试官用它判断你是否持续跟进领域进展、能否把新技术放到自己项目的取舍框架里评估，而不是听说过名词就想上。回答范式：**这个技术解决什么老问题 → 代价是什么 → 我的项目什么条件下值得引入**。

### Q44. 模型上下文都到 1M token 了，直接把整个知识库塞进去，RAG 还有存在的必要吗？

- **想听**：不是「RAG 死了/没死」的站队，而是成本、延迟、质量三个维度的定量直觉。全量塞入的代价是每次请求都为无关内容付 token 费用，延迟随上下文线性增长；lost in the middle 在超长上下文中依然存在（虽然新模型有改善）；知识库会增长而上下文上限是硬的。
- **加分**：能讲混合策略——小库（几十页）可以全量放入并配合 prompt caching 摊薄成本（缓存命中时输入价格大幅下降），这时 RAG 反而是过度工程；库大到放不下或多租户隔离时才需要检索。「先算一下知识库总 token 数再决定要不要 RAG」是 senior 信号。
- **项目落点**：本项目知识库是持续增长的个人笔记且多租户隔离，全量注入不可行；但 knowledge-profile 画像本质上就是「压缩后全量注入」思路的应用——两种范式在同一个项目里各占其位。
- **追问**：prompt caching 和 RAG 怎么结合？（把稳定的知识库前缀做成缓存段，动态检索结果放缓存断点之后）

### Q45. Contextual Retrieval 解决什么问题？你的项目离完整实现还差哪一步？

- **想听**：chunk 脱离文档语境后 embedding 失真的问题（「它的优点是……」这种 chunk 单独看没有任何检索价值）。Anthropic 的做法是索引时让 LLM 为每个 chunk 生成一段结合全文的上下文说明（例：「本段出自 2023 年 Q2 财报，讨论 ACME 公司收入增长」），前置到 chunk 再做 embedding 和 BM25 索引；其公开实验报告检索失败率降低约 49%，加入 rerank 后约 67%，但这些数字依赖具体语料和评测集，不能直接外推。
- **项目落点**：项目已经保存 `headingPath`，并在本地关键词评分和规则 rerank 中使用标题路径，但生成 embedding 时仍只传 `chunk.text`，所以还不是 contextual retrieval。低成本第一步是把 `pageTitle + headingPath` 只拼进 embedding/关键词索引文本，同时保留原始 chunk 作为引用；完整版才是每个 chunk 生成全文感知的上下文说明。
- **追问**：为什么上下文说明要在 embedding 之前拼接，而不是检索后再补？（检索失败发生在向量空间里，事后补救来不及——要让「语境」参与打分本身）

### Q46. 什么样的问题向量检索永远答不好，需要 GraphRAG？

- **想听**：向量检索的能力边界——它擅长「找到和问题语义相近的片段」，但回答不了需要**全局聚合**（「我的笔记里主要在关注哪几类主题？」）或**多跳关系**（「A 项目用的库和 B 项目有哪些重叠？」）的问题，因为答案不在任何单个 chunk 里。GraphRAG 的思路：抽取实体和关系建图，对社区（community）做层次化摘要，全局问题查摘要、局部问题查实体邻域。
- **代价也要说**：索引成本高一个数量级（全库实体关系抽取都要过 LLM）、图谱随文档更新的增量维护很难、抽取质量直接封顶检索质量。大部分「查事实」场景用不上，为了 5% 的全局问题引入全套图谱通常不划算。
- **项目落点**：本项目的 wiki summary → knowledge-profile 链路已经是「层次化摘要回答全局问题」的雏形（模型靠画像知道库里有什么），只是没有建实体图。可以作为「我理解 GraphRAG 动机但选择了更便宜的实现」的论据。

### Q47. bi-encoder、cross-encoder、late interaction（ColBERT）三种架构的本质区别是什么？

- **想听**：交互发生的时机。bi-encoder 把 query 和文档各自压成单向量再算相似度，交互最晚、信息损失最大、但可预计算可建索引；cross-encoder 把 query+文档拼一起过模型，交互最充分但必须在线逐对推理，只能做小候选集精排；ColBERT 是折中——文档保留 token 级多向量（可预计算），查询时做 MaxSim 轻量交互，精度接近 cross-encoder、成本接近 bi-encoder，代价是存储膨胀一到两个数量级。
- **加分**：ColPali 把同一思路用到多模态——直接对文档页面截图做 patch 级多向量，跳过 OCR/版面解析，PDF 表格图表检索效果显著；这说明 late interaction 是一种通用架构思想而不是单个模型。
- **追问**：你的项目要不要上 ColBERT？（个人笔记规模下瓶颈不在召回架构而在评测集太小无法证明收益——先扩评测，这是比换模型更诚实的回答）

### Q48. Self-RAG / CRAG 这类「自我纠错检索」的核心思想是什么？和你项目的受控 fallback 有什么关系？

- **想听**：把「检索质量」本身变成被评估和决策的对象。Self-RAG 训练模型输出反思 token 决定要不要检索、检索结果是否相关、生成是否有据；CRAG 用一个轻量评估器给检索结果打分，按「正确/含糊/错误」分流——错误时丢弃并改走 web search 或 query 改写重试。共同点是：检索不再是「查一次就用」的管道，而是带质量门控的循环。
- **项目落点**：本项目用 Retrieval Router、最多两条计划 query、固定阈值和 Evidence Grader 做 CRAG 风格的规则闭环；弱证据不会因为无结果而放宽门槛。回答后还执行 claim-level citation 与 groundedness 检查。它仍是确定性规则版，不等于训练式 Self-RAG/CRAG evaluator。
- **追问**：规则门槛和训练出来的评估器，边界在哪？（规则只能看分数分布，评估器能看内容相关性；但评估器自己也要评测和维护）

### Q49. 除了固定字符数切块，前沿的分块方案有哪些？各自解决什么问题？

- **想听**：至少两个方向。**Late chunking**：先把整篇文档过长上下文 embedding 模型拿到 token 级向量，再按 chunk 边界池化——每个 chunk 向量天然携带全文语境，解决的是和 contextual retrieval 同一个问题，但不需要 LLM 生成说明，代价是必须换支持长上下文的 embedding 模型。**RAPTOR**：对 chunk 递归聚类并生成多层摘要，检索时可同时命中细节层和摘要层，弥补「答案分散在多个 chunk」的场景。**Semantic chunking**：按相邻句子 embedding 相似度的断崖处切分，而不是按字符数。
- **加分**：知道 semantic chunking 的实测收益经常不稳定（评测显示相对朴素切块提升有限且成本更高），能说「分块收益要靠自己的评测集验证，不能默认新方案更好」。
- **项目落点**：本项目是标题感知 + 700 字符的结构化切块，对笔记类文档（天然有标题层级）已经拿到了大部分收益；RAPTOR 式摘要层和 wiki summary 机制有天然的结合点。

### Q50. Embedding 的存储和成本优化有哪些前沿手段？

- **想听**：**Matryoshka（MRL）**：训练时让向量前缀维度就携带主要信息，检索时可以只用前 256/512 维粗筛、全维度精排，存储和计算按比例下降；**量化**：float32 → int8 或二值向量能显著降低内存，在部分任务上配合原始向量重打分可把质量损失控制在可接受范围，但不能脱离自己的语料直接承诺「几乎无损」；**两阶段检索**：低精度索引粗召回 + 原始精度重排。
- **项目落点**：当前 1024 维 float 存 pgvector，个人规模无压力；但 Q38（千万 chunk）的答案里应该主动把「降维 + 量化 + 分区」作为第一批手段，比「加机器」具体得多。
- **追问**：量化后 HNSW 索引怎么办？（pgvector 支持 halfvec/bit 类型和对应索引；量化在索引层做还是存储层做是不同的取舍）

### Q51. 多模态 RAG：如果你的知识库里有大量截图、PDF 表格，现在的管线会怎样？怎么改？

- **想听**：现有管线只处理文本，图片内容直接丢失。两条路线：**解析路线**——VLM 把图片/表格转成文本描述再走现有管线，兼容性好但版面信息有损；**原生路线**——ColPali/多模态 embedding 直接对页面截图建索引，保真但需要换检索栈和支持多向量的存储。
- **加分**：指出混合现实——生产系统常用「解析为主 + 关键文档原生检索」的分层方案；以及多模态 rerank 目前仍是短板，检索到截图后还需要 VLM 在生成端真正「看」它。
- **项目落点**：Notion 笔记以文本为主，当前取舍合理；但 Notion 页面里的图片块目前在 loader 层就被丢弃了，如果要补，第一步是解析路线（图片过 VLM 生成 caption 拼进正文），不需要动检索架构。

### Q52. Deep Research 类产品（多轮搜索 + 综合报告）和传统 RAG 的本质区别是什么？

- **想听**：范式差异——传统 RAG 是「一次检索、一次生成」的管道，Deep Research 是「规划 → 检索 → 阅读 → 发现缺口 → 再检索」的循环，检索预算从固定变成动态（简单问题一跳、复杂问题几十跳），且中间产物（笔记、大纲）本身进入上下文管理。技术上的关键不是检索算法，而是**任务分解、终止判据和上下文压缩**。
- **加分**：能说出这对评测的冲击——单跳的 Recall@K 无法评估多跳系统，要评「最终报告的事实覆盖率和引用准确率」，评测成本急剧上升。
- **项目落点**：本项目 Agent Loop + search_notes 已经是最小多跳形态（模型可以换 query 再查）；差距在于没有显式的研究规划和中间笔记沉淀。作为个人助手，这是合理的复杂度停止点。

### Q53. Adaptive RAG / Active RAG 为什么强调「什么时候检索」，而不只是「怎么检索」？

- **想听**：所有问题都走同一条检索链路既浪费又不稳定。简单常识题可能不需要检索；单事实题一次检索足够；多跳题需要「推理一步、检索一步」。Adaptive-RAG 用问题复杂度路由不同策略，FLARE 一类 Active Retrieval 则在生成过程中根据低置信内容触发补充检索；更新的 self-routing / multi-round RAG 进一步学习是否继续搜索以及何时停止。
- **关键难点**：路由器的 false negative 比 false positive 更危险。不该跳过检索却跳过，会直接失去事实依据；多检索一次通常只是增加延迟和成本。因此需要按风险设置不对称阈值，并记录 `route/retrievalRounds/stopReason`，分别评估质量、p95 延迟和 token 成本。
- **项目落点**：当前聊天入口在 Agent Loop 前执行显式 Router，输出 `no_retrieval/knowledge/web/both`，再过滤模型可见工具；Query Planner 负责 standalone query、时间/页面过滤和 multi-hop 拆分，单个检索工具每轮只允许调用一次，工具内部最多两条 query。路由 precision/recall 有独立离线数据集和 CI 门槛。
- **追问**：路由器应该用规则、小模型还是主模型？（先用可解释规则和现有主模型日志建立标签；流量和成本足够大时再训练小模型，且必须保留高风险问题的强制检索策略）

### Q54. 实时 RAG / Temporal RAG 和普通的「定时重建索引」有什么不同？

- **想听**：实时 RAG 不只是同步更频繁，而是把**事件时间、知识有效时间和索引可见时间**分开管理。摄取侧需要 webhook/CDC、幂等键、乱序事件处理、删除 tombstone 和版本原子切换；检索侧需要理解「现在」「截至某天」「当时」等时间意图，并用 metadata filter、时间衰减或 `as_of` 查询选择正确版本。
- **工程取舍**：最新不一定最相关，时间衰减不能无条件加入总分；制度、合同、事故记录等场景还必须保留历史版本。实时性也要定义 SLA，例如「源更新后 2 分钟内可检索」，并监控 source-to-index lag，而不是只看同步任务成功率。
- **项目落点**：项目已有 `last_edited_time`、content hash 和页面级原子替换，具备版本一致性的基础；但在线检索没有 `asOf`、有效期或 freshness score，也没有面向乱序更新和删除事件的完整链路。前沿演进点应是事件驱动增量同步 + 可回放事件日志，而不是缩短轮询间隔。
- **追问**：同一事实的新旧文档冲突怎么办？（先按查询时间意图过滤，再结合来源权威度和版本关系排序；无法消解时向用户展示冲突，而不是让相似度分数决定真相）

### Q55. 企业 RAG 为什么会从「向量库问答」演进成 Structured + Unstructured RAG？

- **想听**：向量检索适合找语义证据，不适合精确聚合、过滤和关系运算。「上季度退款金额」「依赖 A 的所有服务」「某客户当前生效合同」应该分别交给 SQL、图查询或业务 API，而不是把数据库行转成文本后期待 embedding 算出答案。成熟系统会先做 source routing，再让不同检索器返回统一的 evidence contract。
- **关键设计**：结构化源必须经过语义层，明确指标定义、join 路径、字段权限和时间口径；模型不能直接获得任意 SQL 权限。多源结果合并时也不能强行把 SQL 数值、图路径和文本相似度压成同一种分数，应保留来源类型和可验证证据。
- **项目落点**：项目已经生成 `compiled_wiki_edges`，但在线 `search_notes` 仍只查询 `documents` 的 vector + keyword 路径，关系边尚未成为可调用检索器。合理下一步是增加只读 graph/structured tool，由 Agent 按问题类型路由，而不是把边数据再次拼成普通 chunk。
- **追问**：什么时候应该做一个统一检索接口，什么时候保留多个工具？（底层可统一 evidence schema；模型侧是否合并取决于路由边界是否清晰、权限是否相同，以及是否需要独立审批和限流）

### Q56. 什么时候应该微调 retriever、reranker 或 generator？RAFT 解决的是哪一层？

- **想听**：先按失败位置选训练对象。正确文档进不了候选集，是 retriever 的领域词汇鸿沟，需要 query-document 正负样本和 hard negative；正确文档已召回但排不上去，是 reranker 问题；证据正确但模型不会引用、会被干扰文档带偏，才是 generator 的适配问题。RAFT 属于最后一类：让模型在「相关文档 + distractor」环境中学习抽取证据、推理和回答，不等于训练向量检索器。
- **数据方法**：hard negative 应来自真实误召回、同主题不同实体和旧版本文档，而不是随机负样本；可以用 LLM 合成 query 扩数据，但必须人工抽检并按文档或时间切分 train/test，避免同一 chunk 的改写同时出现在训练集和评测集造成泄漏。
- **项目落点**：当前使用通用 embedding、规则 rerank 和通用生成模型，评测集只有 6 条，不具备证明微调收益的数据基础。正确顺序是先扩失败样本和分层指标，再优先训练/替换最薄弱的一层；直接上 RAFT 很可能只是把小评测集过拟合得更好看。
- **追问**：为什么先做 reranker 往往比微调 embedding 风险更低？（它只改变候选排序，不改变全库召回空间；可灰度、可快速回滚，也更容易收集成对偏好数据）

### Q57. Query-aware Context Compression 为什么正在成为 RAG 的独立一层？

- **想听**：retrieval candidate 不等于应该完整进入模型的 evidence。候选 chunk 常包含大量与当前问题无关的段落，前沿系统会在召回和生成之间增加过滤/压缩层：句子级抽取、token pruning、去重、按问题重排，或小模型生成保留原文引用坐标的压缩结果。目标是在不损失答案证据的前提下降低 token、延迟和 lost-in-the-middle。
- **风险边界**：压缩器最容易误删否定词、限定条件、数字单位和跨句指代，生成式摘要还可能引入原文没有的事实。因此必须保留原始 source span，允许回看未压缩文本，并分别评估 compression recall、faithfulness 和 token reduction，不能只看最终回答更短。
- **项目落点**：当前用 MMR 去重并限制 topK，但命中的 chunk 会基本原样进入工具结果，还没有 query-aware evidence compression。项目已有 `startChar/endChar/headingPath`，适合先做可追溯的抽取式压缩，而不是直接让 LLM 重写所有证据。
- **追问**：压缩应该发生在 rerank 前还是后？（通常先粗召回和 rerank，再压缩少量高价值候选；过早压缩会放大成本，也可能改变排序所需的信息）

### Q58. RAG 安全为什么要从 Prompt Injection 上升到「知识供应链安全」？

- **想听**：攻击面覆盖摄取、索引、检索和生成全过程。除了文档内指令注入，还包括投毒文档进入知识库、恶意内容操纵 embedding 邻域、ACL 过滤遗漏导致越权召回、删除后缓存仍泄漏、通过反复查询推断私有语料，以及高权威来源被低质量副本覆盖。
- **防线设计**：摄取时记录来源、所有者、版本、content hash 和信任等级，对外部内容做隔离/审核；检索必须在 ANN 召回前执行 ACL pre-filter；生成上下文把文档标成不可信数据；高风险动作要求重新审批；持续运行 poisoning、indirect injection、cross-tenant 和 membership inference eval。
- **项目落点**：当前已有 `userId` 过滤、页面版本元数据和原子同步，但服务端使用 service role，任何漏传租户条件都具有较大影响；同时还没有 source trust、隔离区和 RAG 攻击评测。Q10 的多租户与 Q28 的 Prompt Injection 只是局部控制，这题要求把它们串成端到端威胁模型。
- **追问**：为什么 RLS 仍不能单独解决 RAG 安全？（RLS 解决数据库行访问权限，不判断内容是否被投毒、是否包含恶意指令，也不自动覆盖外部向量索引、缓存和 Trace 等派生数据）

### Q59. 检索结果都有来源，为什么还需要 Claim-level Attribution 和 Verifier？

- **想听**：有来源列表不代表回答中的每个事实都被来源支持。成熟链路会把答案拆成原子 claim，为每条 claim 绑定 source span，再用 NLI/LLM judge 或规则检查 entailment、矛盾和引用完整性；无证据 claim 删除、改写为不确定表达或触发补充检索。
- **冲突处理**：多个来源互相矛盾时不能让模型静默平均。应保留 `source authority + version + valid time + retrieval score`，区分「来源冲突」和「证据不足」；无法自动裁决时把冲突明确展示给用户。Verifier 也不是绝对真相，需要用人工标注集校准并监控误拒绝率。
- **项目落点**：当前生成策略要求模型使用 `[ev_xxx]` Evidence ID，`verifyGroundedAnswer` 会按句拆分 claim，检查未知引用、引用覆盖、词面支持、citation precision 和 groundedness；失败时 `applyGroundednessGuard` 会拒答或追加风险提示。它已经是在线 Claim-level Guard，但词面重叠不能可靠判断同义支持、否定和矛盾，因此下一步应引入可校准的 NLI/LLM Verifier，并保留当前规则作为低成本第一层。
- **追问**：Verifier 应该阻断回答还是只打分？（低风险场景先旁路打分收集分布；高风险领域或明确无证据 claim 才阻断，避免未经校准的 judge 造成大面积误拒绝）

### Q60. `evidenceRequired` 为什么是 RAG 路由中的关键字段？

- **回答思路**：路由不只决定“用不用检索”，还要表达检索失败后的正确性语义。用户明确要求“查我的笔记”“联网看最新官网”时，证据是硬需求；知识画像只是推测相关时，检索属于软优化。把两者混在一起，会导致硬需求下无证据乱答，或软命中失败时无谓拒答。
- **项目落点**：`buildRetrievalPlan` 对显式 private/web/both 意图设置 `evidenceRequired=true`，知识画像 overlap 路由保持 false；最终 `verifyGroundedAnswer` 在硬需求且零证据时返回 fail。
- **追问**：`webEnabled=false` 时用户明确问最新信息怎么办？（不能保留不可用 Web 工具；应明确能力受限，不能把旧参数知识描述成已联网结果）

### Q61. Query Cache 为什么必须同时考虑租户、索引版本和数据源？

- **回答思路**：只按 query 缓存会造成跨用户泄漏；知识库更新后旧结果会变陈旧；Web 搜索与私有知识有不同的失效条件，不能共用同一个版本键。缓存键要覆盖所有影响结果的维度，同时对返回值做 defensive clone，避免调用方修改缓存对象。
- **项目落点**：Knowledge Cache 按 tenant、indexVersion、query 和 filters 隔离；Web Cache 使用独立版本并区分 search depth，不会因为某个用户的私有索引升级而全量失效。
- **追问**：索引切换后是否应该立即删除旧缓存？（版本化 key 可让旧缓存自然失效；再通过 TTL/容量清理，避免同步删除成为发布阻塞点）

### Q62. RAG Ingestion Worker 如何防止两个 Worker 同时处理一条任务？

- **回答思路**：用数据库 RPC 原子 claim，写入 `worker_id`、`lease_until`、`status=running` 和 attempts；完成或失败更新时再次校验 worker/status，lease 丢失就不能覆盖新 Worker 的结果。失败采用有界指数退避，耗尽后进入 dead 状态。
- **项目落点**：`claim_rag_ingestion_jobs` 负责领取；应用完成更新使用 `id + worker_id + running` 条件。页面索引替换内部还使用事务级 advisory lock，解决“任务唯一”和“同页写入串行”两个不同层次的问题。
- **追问**：Worker 执行超过 lease 怎么办？（长任务需要 heartbeat 续租；没有续租时应把 lease 设为最坏耗时并监控 lease_lost，不能无限加大 lease 掩盖问题）

### Q63. `web_fetch` 当前做了哪些 SSRF 防护？还缺什么？

- **回答思路**：已有 URL 解析、仅允许 HTTP(S)、字面 localhost/私网/云元数据地址拦截、手动重定向逐跳校验、响应类型/大小限制和超时。缺口是 DNS 解析后未检查实际 IP，也没有把连接固定到已验证地址，仍可能被 DNS rebinding 或特殊地址表示绕过。
- **项目落点**：安全判断位于 `lib/agent/tools/web-fetch.ts`；生产强化应使用安全 DNS resolver，拒绝 private/reserved CIDR，逐次重定向重新解析，或让受控 egress proxy 统一执行外连。
- **追问**：为什么只判断 hostname 字符串不够？（合法域名可以解析到内网地址，并可在校验与连接之间改变解析结果）

### Q64. RAG 失败时如何设计“可观测降级”而不是静默 fallback？

- **回答思路**：区分路由失败、embedding、keyword RPC、reranker、cache、超时、证据不足和回答校验失败；每种降级都写入 Trace 的 reason、attempt、timing 和 evidence 状态。只有不破坏用户证据承诺的路径才能降级。
- **项目落点**：RetrievalTrace 已包含 route、evidenceRequired、attempts、cacheHits、thresholdFallback、scoreGap、degradationReason 和 timings；Langfuse summary 避免上传原始 query。下一步应按 reason 建低基数 Metrics 和告警。
- **追问**：为什么“返回一个空数组”不是合格降级？（调用方无法区分真实无结果与系统故障，线上 no-result 率也会被基础设施错误污染）

### 前沿术语速查

> 下面是检索论文和准备追问的关键词，不代表项目已经实现。

| 方向 | 关键词 | 面试时要讲清的核心取舍 |
|---|---|---|
| 动态检索 | Adaptive-RAG、FLARE、Self-Routing RAG、multi-round stopping | 质量收益与额外轮次、停止错误、路由 false negative |
| 长上下文协同 | CAG、prompt caching、long-context + RAG hybrid | 全量上下文成本与检索遗漏之间的权衡 |
| 分层与语境 | Contextual Retrieval、Late Chunking、RAPTOR | 索引成本、语境保留和多粒度召回 |
| 领域适配 | hard negative mining、domain reranker、RAFT | 先定位失败层，再决定训练哪一层 |
| 实时知识 | Streaming RAG、temporal retrieval、event-time indexing | freshness SLA、乱序事件、历史版本与可回放性 |
| 安全治理 | SafeRAG、privacy-aware retrieval、poisoning eval | ACL 只是底线，还要覆盖投毒、泄漏和派生数据 |
| 证据验证 | claim attribution、citation entailment、conflict-aware RAG | 来源存在不等于声明被支持，Verifier 也必须校准 |

---

## 备考策略

- **必考核心十题**：Q2（完整链路）、Q3（混合检索）、Q5（切块权衡）、Q9/Q23（无结果策略）、Q11（工具化 RAG）、Q18（分数融合）、Q22（MMR）、Q24（同步原子性）、Q30（指标）、Q35（ablation）。先练到能脱稿流畅讲出来。
- **两张王牌**（大部分候选人没有，主动往这引导话题）：
  1. Q7 中文 FTS 分词的真实踩坑；
  2. Q15/Q35 的 ablation 评测能力，以及敢于说明当前规则 rerank 和 6 条评测集的边界。
- **已知短板**：评测集目前只有 6 条用例（`lib/agent/eval/rag-cases.ts`）。要么面试前扩充，要么准备好「我知道它小、我计划按 category 各扩 5-10 条并加 LLM-as-judge 端到端评测」的说辞。
- **主动承认的真实缺口**：RRF、动态权重和条件触发规则尚未在大规模 golden set 上校准；Cross-Encoder 默认关闭且缺少真实 provider 基准；parent 仍重复存于 child metadata；语义切块没有默认启用。无结果降到 0、同步非原子、单 query 向量召回和词面 MMR 问题已经在代码层修复，但仍需数据库集成测试。
- **前沿层的用法**：第八层不要主动背诵名词，而是在相关问题里自然带出——答 Q5 切块时带 contextual retrieval / late chunking，答 Q9 无结果策略时映射到 CRAG，答 Q11 工具路由时带 Adaptive RAG，答 Q28 安全时扩展到知识供应链，答 Q37 引用排障时带 claim-level verifier，答 Q38 扩展性时带量化和 MRL。每个话题都用「解决什么老问题 → 代价 → 我的项目为什么（暂时不）需要」的框架讲。
- **叙事主线**（比罗列技术点更有说服力）：
  > 「先做纯向量检索 v1 → 评测发现精确术语查询召回差 → 加 FTS 混合检索 → 发现 top-k 冗余，加 MMR → 每步用 golden set 跑 ablation 验证 → 最后把 RAG 从前置注入重构为 Agent 工具，用 LLM 生成的知识库画像解决路由问题。」

---

## 项目证据索引

| 主题 | 代码位置 | 面试可讲内容 |
|---|---|---|
| 分块 | `lib/knowledge/chunking.ts` | 字符/token 双上限、标题/代码/表格结构、句子边界、chunk kind |
| 同步 | `lib/knowledge/sync.ts` | content hash、embedding/chunker 版本、向量完整性校验、原子 RPC 替换 |
| Embedding | `lib/knowledge/embedding.ts` | `text-embedding-v4`、provider index 重排、完整性校验、分批重试、稳定幂等键 |
| 混合检索 | `lib/knowledge/retriever.ts` | standalone/multi-query、并行双路召回、RRF/校准加权、条件精排、向量 MMR |
| Cross-Encoder | `lib/knowledge/reranker.ts` | 通用 HTTP provider、响应完整性校验、超时与规则降级 |
| 关键词 SQL | `docs/schemas/migrations/20260704-rag-keyword-search.sql` | Postgres FTS、LIKE/overlap 中文兜底、用户过滤 |
| 多租户 | `docs/schemas/migrations/20260628-rag-multitenant.sql` | user_id、RPC pre-filter、HNSW、级联删除 |
| Agent 工具 | `lib/agent/tools/search-notes.ts` | 固定阈值检索、有限 query retry、EvidenceBundle 与 RAG debug metadata |
| Retrieval Router | `lib/agent/rag/retrieval-router.ts` | hard/soft evidence、knowledge/web/both/no_retrieval、工具过滤和步骤级收窄 |
| Evidence Guard | `lib/agent/rag/answer-verifier.ts` | Evidence ID、claim 拆分、引用精度/覆盖率和 groundedness guard |
| Query Cache | `lib/agent/rag/query-cache.ts` | tenant/index/source/depth 隔离、TTL 与 defensive clone |
| Ingestion Queue | `lib/knowledge/ingestion-queue.ts` | 数据库 lease、指数退避、dead 状态和 worker 所有权校验 |
| 知识库画像 | `lib/agent/tools/knowledge-profile.ts` | wiki summary 压缩、source hash 缓存和持久化 |
| 评测数据 | `lib/agent/eval/rag-cases.ts` | 六类 case 结构、当前规模限制 |
| 评测脚本 | `scripts/rag-eval.ts` | Recall@K/MRR/no-result、RRF/weighted、multi-query 和 Cross-Encoder 消融 |
| Trace UI | `app/traces/[id]/page.tsx` | 融合、候选、MMR、Cross-Encoder、阶段耗时、上下文预算和代理指标边界 |

## 一句话复习版

这套项目的亮点不是“用了向量数据库”，而是已经形成 **版本化且原子化的摄取 + standalone/multi-query 并行召回 + RRF + 条件精排 + 向量 MMR + parent-child 上下文 + hard/soft evidence 路由 + Claim-level Guard + 可消融评测 + Trace** 的完整骨架；面试时最重要的是既能讲清这条链路，也能诚实指出 **评测规模、真实 provider/数据库集成、词面 Verifier、DNS 级 SSRF 防护、parent 存储模型和语义切块** 仍需继续工程化。
