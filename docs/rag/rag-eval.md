# RAG 评估闭环

这套评估用来回答一个问题：改了 chunk、embedding、keyword search、rerank 或 prompt 之后，RAG 到底变好了还是变差了。

## 快速运行

```bash
npm run test:rag
```

常用参数：

```bash
npm run test:rag -- --limit 5 --threshold 0.4
npm run test:rag -- --case rag-concepts,notion-sync
npm run test:rag -- --out reports/rag-eval/latest.json
npm run test:rag -- --no-keyword
npm run test:rag -- --no-rerank
npm run test:rag -- --no-multi-query-vector
npm run test:rag -- --fusion rrf
npm run test:rag -- --fusion weighted
npm run test:rag -- --cross-encoder
```

如果需要限定用户知识库：

```bash
npm run test:rag -- --user-id <uuid>
```

也可以在 `.env.local` 放：

```bash
DEFAULT_USER_ID=<uuid>
```

## Case 文件

测试用例维护在：

```text
lib/agent/eval/datasets/rag.ts
```

推荐每条 case 尽量写真实问题：

```ts
{
  id: "agent-patterns",
  question: "Agent 范式有哪些？",
  expectedPageTitles: ["Agent 设计"],
  expectedKeywords: ["ReAct", "Reflection", "Tool"],
  category: "keyword",
}
```

命中条件从稳定到宽松：

```text
expectedPageIds     最稳定，适合固定 Notion page_id
expectedPageTitles  最好维护，适合人工用例
expectedUrls        适合 URL 稳定的资料
expectedKeywords    检查召回 chunk 是否包含关键信息
expectedNoResult    检查知识库没有答案时是否不乱召回
```

## 指标解释

```text
passRate
  case 通过率。source 命中、关键词覆盖、no-result 都会影响。

recall@K
  前 K 条结果里是否出现期望 source。只统计写了 expectedPageIds / expectedPageTitles / expectedUrls 的 case。

mrr
  期望 source 排名越靠前越高。第 1 名是 1，第 2 名是 0.5，第 3 名是 0.333。

keywordCoverage
  expectedKeywords 有多少出现在召回结果里。

noResultAccuracy
  expectedNoResult case 是否没有返回结果。

avgLatencyMs
  平均检索耗时。
```

## 调参方法

先跑基线：

```bash
npm run test:rag -- --out reports/rag-eval/baseline.json
```

再做对照：

```bash
npm run test:rag -- --no-keyword --out reports/rag-eval/no-keyword.json
npm run test:rag -- --no-rerank --out reports/rag-eval/no-rerank.json
npm run test:rag -- --fusion rrf --out reports/rag-eval/rrf.json
npm run test:rag -- --fusion weighted --out reports/rag-eval/weighted.json
npm run test:rag -- --no-multi-query-vector --out reports/rag-eval/single-vector-query.json
npm run test:rag -- --threshold 0.4 --out reports/rag-eval/threshold-04.json
```

看差异：

```text
keyword search 是否提高 keywordCoverage
rerank 是否提高 mrr
threshold 是否降低误召回，但不要把 recall 打没
RRF 是否比校准加权提高 MRR/no-result accuracy
multi-query vector 是否提高语义召回，以及增加多少延迟
Cross-Encoder 是否只在困难 case 上带来净收益
```

## 初期建议

先人工补 30-50 条真实问题，不要一开始追求 LLM-as-judge。

case 类型至少覆盖：

```text
direct       原文直接有答案
keyword      关键词/专有名词很重要
semantic     需要语义理解
multi-hop    需要跨多篇文档
no-result    知识库没有答案
confusing    容易和相似主题混淆
```

等 retrieval 稳定后，再加回答质量评估。

## Trace 监控

离线 eval 和线上 trace 分工不同：

```text
离线 eval
  有 expected source / keyword / no-result，能判断 pass/fail。

线上 trace
  没有标准答案，主要看每次 RAG 的过程是否健康。
```

当前 trace 会记录两类 RAG 信息：

```text
自动知识库注入
  写在 model step 的「知识库检索」system segment metadata 中。

search_notes 工具调用
  写在 tool step 的 metadata.rag 中。
```

建议线上重点看：

```text
originalQuery / standaloneQuery / rewrittenQueries / queryType
fusionStrategy / rrfK / vectorWeight / keywordWeight
vectorQueryCount / multiQueryVectorEnabled
vectorCandidateCount / keywordCandidateCount
mergedCandidateCount / candidateCount / candidateLimit / returnedCount
mmrSimilarityMode
crossEncoderUsed / crossEncoderReason / crossEncoderError
timings.embeddingMs / vectorSearchMs / keywordSearchMs / parallelRecallMs
topResults
usedFallback
error
```

这些信息能帮助判断：

```text
是不是没搜到
是不是只走了 vector 没走 keyword
是不是只有受控二级召回才有结果，以及弱证据是否被门槛拒绝
是不是 top results 明显跑偏
是不是检索耗时过高
```

## P1 回归与最终上下文评估

```bash
# 36 条固定召回、带来源标签的离线案例，不依赖真实 Notion/API。
npm run test:rag-regression
# 真实知识库：评估 search_notes 最终可见的正文，而不只评估粗检索结果。
npm run test:rag-context -- --user-id <uuid> --dataset <labelled-cases.json> --out reports/rag-eval/context.json
```

离线案例在 `lib/agent/eval/datasets/rag-regression.ts`，覆盖直接检索、中文词项、专有名词、相似主题、多跳与无答案。来源字段引用项目代码；固定召回分数刻意包含高相似度的无关候选，用来检查融合、MMR、parent 扩展、裁剪和证据门槛。它们不衡量真实 embedding 的语义召回率，也不替代用户知识库人工标注。

真实用例 JSON 的格式与 `RagEvalCase` 一致。正例应使用知识库实际 `pageId`，多跳场景可用 `expectedAllPageIds` 要求每篇来源都存在。`expectedEvidenceSufficient` 用于检测无答案/部分覆盖是否被错误判为充分，仅支持 `--tool-context` 模式。关键词检查使用最终可见正文；报告新增 `sufficiencyAccuracy` 和 `maxContextTokens`。原来的 `test:rag` 保留原始检索评估，用于召回消融；两种模式分别维护 baseline。

```json
[
  {
    "id": "cross-document-comparison",
    "question": "比较我笔记里的两个方案",
    "expectedAllPageIds": ["替换为真实页面ID-A", "替换为真实页面ID-B"],
    "expectedKeywords": ["替换为答案关键内容"],
    "expectedEvidenceSufficient": true,
    "category": "multi-hop"
  }
]
```

中文索引迁移见 `docs/schemas/migrations/20261002-rag-lexical-search.sql`，在 correctness 迁移之后执行。该迁移新增并回填 `lexical_vector` 生成列和 GIN 索引；已有文档无需重新调用 embedding。索引按正文/标题/heading 生成一致的中文双字词项，标题和 heading 加权。迁移会对表执行 DDL，生产应用前应安排适合数据量的维护窗口。

SQL 回归脚本可使用独立的 PGlite 临时运行时，不需要更改项目依赖或连接生产库：

```bash
npm install --prefix /tmp/personal-assistant-rag-sql-check @electric-sql/pglite@0.5.8 --no-audit --no-fund
node --import tsx scripts/rag-lexical-sql-check.mjs --pglite-path /tmp/personal-assistant-rag-sql-check/node_modules/@electric-sql/pglite/dist/index.js
```

该脚本检查迁移重复执行、中文召回、JS/SQL 词项一致性、GIN 执行计划、租户隔离和过滤。它使用独立数据库与文本向量占位字段，不测试 pgvector/HNSW。
