# RAG 检索质量升级说明

## 目标与当前状态

本轮升级把在线检索链路调整为：

```text
多轮上下文
  -> standalone query
  -> 最多 3 个 query rewrite
  -> [批量 embedding + 多路向量召回] 与 [关键词召回] 并行
  -> RRF（默认）或校准加权融合
  -> 融合后候选池硬裁剪
  -> 规则 rerank
  -> 条件式 Cross-Encoder（可选）
  -> 向量 MMR
  -> child 命中、parent 投喂
  -> TopK 与 token 预算裁剪
```

核心实现位于：

- `lib/knowledge/retriever.ts`
- `lib/knowledge/reranker.ts`
- `lib/knowledge/chunking.ts`
- `lib/knowledge/sync.ts`
- `lib/agent/tools/search-notes.ts`

向量 MMR 需要数据库 RPC 返回候选 embedding。部署时必须执行：

```text
docs/schemas/migrations/20260717-rag-retrieval-quality.sql
```

未执行该迁移时，检索仍可运行，但 MMR 会从向量余弦相似度降级为文本 Jaccard。

## 1. RRF 与校准加权融合

### 为什么不直接相加原始分数

cosine similarity、Postgres FTS rank 和词面 overlap 来自不同分布。即使都落在 0 到 1，`0.8` 也不代表同一种置信度。固定执行 `0.7 * vector + 0.3 * keyword` 会让某一路的分数尺度长期支配排序。

### 默认方案：Weighted RRF

RRF 只使用每一路的排序位置：

```text
score(document) = sum(weight(list) / (rrfK + rank(document, list)))
```

当前 `rrfK=60`。多个 query rewrite 的向量列表共享 vector 总权重，关键词列表使用 keyword 权重。一个文档在多个 query 或 vector/keyword 两路重复出现时，会获得共识加分。

### 消融方案：校准加权

保留 `fusionStrategy=weighted` 作为对照。每路分数先结合原始分数和列表内 rank percentile 做轻量校准，再执行动态加权。它仍不是训练得到的 Platt/Isotonic 校准，因此主要用于可解释基线和消融，不应被视为最终概率。

### Query 类型动态权重

| Query 类型 | Vector | Keyword | 典型问题 |
| --- | ---: | ---: | --- |
| exact | 0.45 | 0.55 | 错误码、API、常量、精确术语 |
| semantic | 0.75 | 0.25 | 原理、设计、解释类问题 |
| multi-hop | 0.65 | 0.35 | 比较、关系、跨文档问题 |
| balanced | 0.70 | 0.30 | 普通查询 |

这组权重是启发式初值，必须用项目自己的 golden set 校准。

## 2. Multi-query Vector Retrieval

规则 rewrite 最多生成三个版本：

1. 原始或 standalone query。
2. 去掉“请问、如何、介绍一下”等问句包装后的版本。
3. 错误名、环境变量、API 名等技术术语版本。

所有版本通过一次 `embedBatch` 生成向量，再分别执行向量召回；各向量列表最终通过 RRF 合并。`--no-multi-query-vector` 可让向量路径只使用第一个 query，同时保留全部 rewrite 给关键词路径，用于消融 multi-query 的实际收益和延迟。

多轮场景有两层保护：

- `search_notes` schema 要求模型传入脱离代词也能理解的 query。
- Runtime 会把当前用户消息之前的最近对话文本传给检索器；当 query 以“那、它、这个、上述”等指代表达开头时，检索器构造 standalone query。

当前 standalone 逻辑是确定性兜底，不是一次额外 LLM rewrite。它成本低、可观测，但对复杂省略和实体消歧仍有限。

## 3. 并行召回

关键词召回与完整的向量路径并行启动：

```text
Promise.all([
  embedding -> multi-query vector RPC,
  keyword RPC,
])
```

Trace 分别记录：

- `embeddingMs`
- `vectorSearchMs`
- `keywordSearchMs`
- `parallelRecallMs`
- `totalMs`

因此可以验证总召回耗时接近较慢分支，而不是两路耗时之和。当前任一非预期分支异常仍会让本次检索失败；后续若要做 partial-result 降级，需要同时记录路径错误，避免静默吞掉长期故障。

## 4. 条件式 Cross-Encoder

规则 rerank 仍是默认快速路径。只有启用 Cross-Encoder 且满足以下任一条件时才调用外部 rerank provider：

- query 被识别为 multi-hop；
- top score 低于阈值；
- top1 与 top2 分差过小；
- 前三名的 vector/keyword 来源排序存在冲突；
- 配置为 `always` 模式。

Cross-Encoder 只处理融合后的前 12 个候选。最终分数为：

```text
0.85 * crossEncoderScore + 0.15 * ruleRerankScore
```

请求超时、HTTP 错误、返回数量/index 异常时，系统保留规则 rerank 排序继续执行，并把 `crossEncoderError` 写入 Trace。

配置：

```env
RAG_CROSS_ENCODER_ENABLED=true
RAG_CROSS_ENCODER_MODE=conditional
RAG_RERANK_URL=
RAG_RERANK_MODEL=
RAG_RERANK_API_KEY=
```

未配置独立 key 时会回退 `DASHSCOPE_API_KEY`。默认关闭，避免无意增加在线成本。

## 5. 向量 MMR、Parent-Child 与结构化分块

### 向量 MMR

相关性使用 rerank score，重复度优先使用候选 embedding 的 cosine similarity：

```text
MMR = lambda * relevance - (1 - lambda) * maxSimilarity(selected)
```

当前 `lambda=0.7`。候选向量全部可用时模式为 `vector`，部分可用时为 `hybrid`，迁移未部署或向量缺失时为 `text`。

### Parent-Child Retrieval

- child chunk 较小，用于 embedding 和精确检索。
- 同标题路径下的相邻 child 合并为不超过 1800 字符的 parent context。
- 检索结果按 `parent_key` 去重，模型看到 parent，引用和 Trace 仍保留命中的 child。

当前 parent 内容保存在 child metadata 中，适合现有个人知识库规模。大规模部署应改成独立 parent 表，避免每个 child 重复存储父文本。

### 分块策略

`structure-token-v2` 同时约束：

- 最大 700 字符；
- 最大 450 tokens；
- 50 tokens overlap；
- Markdown 标题路径；
- 代码围栏完整性；
- Markdown 表格完整性；
- 超长结构按句子或换行边界切分。

这已经从固定字符切块升级为结构和 token 感知，但还没有默认启用基于 embedding 断点的 semantic chunking。语义切块会增加索引成本，且公开评测中的收益并不稳定，应先在当前 golden set 上做独立实验。

## 6. TopK 与上下文预算

统一约束如下：

| 层级 | 默认值 | 作用 |
| --- | ---: | --- |
| 最终 TopK | 5 | Retriever 和 tool 的共同硬上限 |
| 候选倍数 | 4 | 默认粗召回池为 `topK * 4` |
| 融合候选池 | 50 | 进入 rerank/MMR 前的硬上限 |
| Cross-Encoder 候选 | 12 | 控制外部 rerank 成本 |
| Parent context | 1800 chars | 控制单来源长度 |
| 最终工具上下文 | 2400 tokens | 控制回灌模型的总预算 |

模型传入 `limit=100` 也只会得到最多 5 条。相同 parent 只投喂一次；内部 embedding 和重复 parent 内容不会出现在工具结构化输出中。

## 7. 评测与 Trace

RRF 与 weighted 对照：

```bash
npm run test:rag -- --fusion rrf --out reports/rag-eval/rrf.json
npm run test:rag -- --fusion weighted --out reports/rag-eval/weighted.json
```

Multi-query 消融：

```bash
npm run test:rag -- --no-multi-query-vector --out reports/rag-eval/single-vector-query.json
```

条件式 Cross-Encoder：

```bash
npm run test:rag -- --cross-encoder --out reports/rag-eval/cross-encoder.json
```

每次实验必须固定知识库版本、case、TopK 和阈值，并同时比较 Recall@K、MRR、no-result accuracy、平均延迟及各 category 结果。当前评测集规模较小，只能做回归保护，不能据此宣称某策略具有统计显著优势。

Trace 页面会展示 query 类型、standalone/rewrite、向量 query 数、融合方式、候选池、动态权重、MMR 模式、Cross-Encoder 决策、分阶段耗时、parent 去重和上下文 token 数。

## 8. 部署与验证边界

1. 先执行 `20260717-rag-retrieval-quality.sql`。
2. 因 chunker version 已升级，重新同步页面以生成结构化 chunk 和 parent metadata。
3. 分别运行 RRF、weighted 和 single-query 基线。
4. 只有离线收益覆盖额外延迟时，才在生产启用 Cross-Encoder。

单元测试覆盖 RRF 共识、多 query、并行召回、候选硬上限、校准加权、向量 MMR、条件式 Cross-Encoder、standalone query、结构化分块、parent context 和最终 token 预算。真实 Supabase RPC 与真实 Cross-Encoder provider 仍需要部署环境集成验证。
