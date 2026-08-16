# 记忆冲突治理与召回改造（历史表 / 硬删除 / 关键词通道）

## 这个功能解决什么问题

起因是一个具体的失败场景：用户先说「购车预算 5 万」，后来改成「8 万」，再问「我之前预算多少」，
系统答 5 万。拆开看是**四个独立缺陷**叠在一起，每个都能单独造成答错：

1. **入口就没进召回**：判断「要不要查长期记忆」的正则不认「我之前……」这类问法，
   整条召回链路根本没被触发。
2. **写入判定兜底方向错**：判不准是「新事实」还是「覆盖旧事实」时，兜底走了 UPSERT，
   于是同一个槽位长出两条 active，5 万和 8 万同时存在。
3. **旧值无处可去**：只有软失效（`status = 'invalidated'`），没有历史表，
   「什么时候改的、之前是多少」这类问题无法回答。
4. **纯向量召回分不开数字**：「8 万」与「5 万」的余弦距离小到可忽略，
   排序器再怎么调也分不出这两条 —— 这是最容易被误诊为「调权重就能解决」的一条。

顺带暴露一个隐私缺陷：引入历史表 **会制造新问题** —— 原本软失效后「我住哪里」至少不再进 prompt，
有了历史表 + 历史查询工具，同一条信息又能被翻出来。用户说了「忘记我住哪里」，系统却还留着可检索的记录。

## 核心概念

### 双时态（bi-temporal）

历史表有两条时间轴，混用其中任何一条都会答错一整类问题：

| 轴 | 列 | 回答的问题 |
|---|---|---|
| 有效轴 | `effective_from` / `effective_to` | 「现实世界里这个事实何时为真」 |
| 记录轴 | `recorded_at` / `superseded_at` | 「系统何时知道 / 何时不再采信」 |

`recorded_at` 存的是**旧行原本的 `created_at`**，不是归档时刻；归档时刻是 `superseded_at`。
写错这一列，「系统在某时刻认为什么是真的」这类查询会全部答错。

### evolution 与 correction 必须区分

| 类型 | 含义 | 旧值的有效期 |
|---|---|---|
| `evolution` | 事实真的变了（预算从 5 万涨到 8 万） | 截到用户表达新值的时刻，**旧值曾经为真** |
| `correction` | 系统当初记错了（其实一直是 8 万） | `effective_to = effective_from`，**从未为真** |

把 correction 按 evolution 处理，历史会声称「5 万曾经真的成立过一段时间」——
这是在向用户复述一段没发生过的事。

### 保留期 ≠ 删除语义

- `memory:history:cleanup`：「时间到了自动清」，运维动作，跨用户扫描，按类型分档。
- `purge_memory`：「用户现在要求彻底抹掉」，隐私合规动作，指定 user_id + key，三张表同事务硬删。

行业共识里的「不让模型硬删」说的是**不让模型自作主张删**，不是**不允许用户授权删**。
这两件事混成一件，就会做出一个删不掉数据的记忆系统。

### 向量与关键词是两条并列通道，不是主备

向量认得同义改写，认不出数字；关键词认得数字与专名，认不出同义改写。
所以合并是**并集不是交集**：向量分高但关键词没命中的条目必须保留，
否则关键词通道的收益会被它自己抵消掉。

## 工程实现

### 整体流程

```
用户提问
  └─ shouldRecall(query)                      入口判定（正则，纯函数）
  └─ recallRankedMemories(query)
        ├─ 向量通道  semantic.recall(query, threshold = 严阈值 × 0.7)   ← 宽召回
        ├─ 关键词通道 extractMemoryQueryTerms(query) → recallByKeyword   ← 两条并行
        ├─ fuseMemoryChannels(...)            并集合并 + 融合打分
        ├─ rankMemoryHits(...)                 只做 status / confidence 治理硬过滤
        ├─ Qwen3-Rerank                        对宽候选逐条输出 crossEncoderScore
        ├─ crossEncoderScore >= 评估阈值       模型成功时的相关性准入
        └─ slice(0, 3)                         取模型排序后的 top-3

Qwen 关闭、未配置、超时或失败时：
        └─ admitFusedMemories(...)             回退原向量 / 强关键词规则阈值

用户说了新事实
  └─ 抽取 → 写入判定（intent: upsert / correct / forget / purge）
        ├─ upsert / correct → upsert_memory RPC
        │     事务内：归档旧行到 agent_memory_history → 覆盖两层
        │     带 FOR UPDATE 行锁 + expected_version 乐观校验 + p_effective_at 反序保护
        ├─ forget          → invalidate_memory（软失效，历史留着）
        └─ purge           → purge_memory（三张表硬删，历史一并删）
```

### 关键代码走读

**存储侧**（[20260804-memory-history.sql](../../schemas/migrations/20260804-memory-history.sql)）

- `agent_memory_history` 存旧行**完整快照**而不只是 `content`：审计要回答「当时这条是
  user_explicit 还是 inferred、confidence 多少」，缺了这些字段恢复只能靠默认值重建，等于二次失真。
- 历史表**不带 embedding**，不参与向量召回。历史版本若带向量进 HNSW，会挤占 `match_count`
  名额（filtered-ANN），导致当前值召回条数变少甚至召不回。
- `upsert_memory` 里 `FOR UPDATE` + `expected_version` 是**两件事**：行锁保证不同时写，
  版本校验保证后写者知道自己在覆盖什么。少了版本校验，并发固化会在历史表里留下重复归档。
- `p_effective_at` 反序保护：固化是 fire-and-forget，两次固化可以重叠并反序完成。
  没有它，用户会看到「我明明改成 8w 了」。
- `purge_memory` 三张表同事务删（[atomic-writer.ts](../../../lib/agent/memory/atomic-writer.ts)
  的 `purgeMemoryKey`）。缺 `userId` 时**直接返回不调 RPC**：service-role 绕过 RLS，
  `p_user_id` 为空会让删除条件退化成跨用户匹配。

**召回工具**（[memory-recall.ts](../../../lib/agent/tools/memory-recall.ts)）

- `recall_memory` / `search_memory_history` 两个工具都是 `runtime.requiresAuth: true`，
  `userId` **只从 `ToolExecutionContext` 取**，`input_schema` 里根本没有 `userId` 字段 ——
  有了这个字段，模型就能越权读别人的记忆。
- `retrieval.source: "memory"` 而不是复用 `"knowledge"`：复用会让路由判定「本轮不查知识库」
  连记忆一起掐掉。
- 查不到时返回 `ok: true` + 「查过了没有」。报成失败会让模型重试同一次召回；
  而 purge 过的 key 查不到是**正确行为**，不是故障。
- `truth_as_of` 缺 `asOf` 时拒绝，不兜底成 `NOW()`：兜底会让它静默退化成 `recall_memory`，
  而模型以为自己查的是历史上某一时刻。

**关键词通道**

- SQL（[20260804-memory-keyword-channel.sql](../../schemas/migrations/20260804-memory-keyword-channel.sql)）：
  `match_memories_keyword` 使用应用层展开的同义词做宽候选召回；SQL 的 `overlap_rank`
  只负责候选排序，不再作为最终关键词分。
- 切词（[keyword-terms.ts](../../../lib/agent/memory/keyword-terms.ts)）：数字 → Latin 词 →
  受控 key 字面量与中文标签 → `Intl.Segmenter` 切中文，逐层过停用词表。同义表达如
  `不喜欢/讨厌/不吃/忌口` 只用于扩大 SQL 候选，不产生最终关键词分；最终关键词分只保留
  数字、Latin 型号和精确受控 key 这类可解释的强字面信号。
- 融合（[fusion.ts](../../../lib/agent/memory/fusion.ts)）：`vector_only` / `weighted` / `rrf`
  三种策略，`MEMORY_FUSION_STRATEGY` 切换。当前默认 `weighted`，**这是待验证的默认值不是结论**。

记忆候选先做状态和置信度治理硬过滤，再进入 Qwen3 Cross-Encoder；模型成功且配置了
`MEMORY_RERANK_ADMIT_THRESHOLD` 时，`crossEncoderScore` 同时负责相关性准入和排序，
因此可以救回旧向量/关键词严阈值会提前挡掉的候选。模型未启用、未配置、超时、失败，
或准入阈值仍留空时，系统完整回退原向量/强关键词规则，不负责判断事实真伪。
每次重排会把候选正文、向量分、关键词分、融合分、规则分、Qwen 分、准入结果、
准入原因、是否由模型救回和排序变化同步写入
`agent_traces.steps[type=memory_recall]` 与 Langfuse `memory.recall`/`memory.rerank` observation；
同时记录百炼响应的 request ID、model 与 `usage.total_tokens`，写入前使用项目统一的敏感数据脱敏器。

```env
# 是否启用长期记忆的 Qwen3 模型重排；false 时只使用原有规则排序。
MEMORY_RERANK_ENABLED=false
# always 对每个非空宽候选池调用；conditional 仅在旧规则不能覆盖全部候选时调用。
MEMORY_RERANK_MODE=always
# 百炼重排模型名称。
MEMORY_RERANK_MODEL=qwen3-rerank
# 包含 WorkspaceId 的完整百炼 rerank endpoint。
MEMORY_RERANK_URL=
# 调用 MEMORY_RERANK_URL 的 API Key；不会自动复用其他 DashScope Key。
MEMORY_RERANK_API_KEY=
# 模型判断候选相关性时使用的任务指令。
MEMORY_RERANK_INSTRUCT=Given a user memory retrieval query, retrieve relevant personal memory passages that answer the query.
# 单次最多送入模型重排的候选数，允许范围 2-24。
MEMORY_RERANK_CANDIDATE_COUNT=12
# 模型相关性准入阈值，必须用真实记忆标注集评估后填写；留空时只采集分数并回退旧规则。
MEMORY_RERANK_ADMIT_THRESHOLD=
# HTTP 请求超时时间，单位毫秒；失败或超时会回退规则排序。
MEMORY_RERANK_TIMEOUT_MS=1200
```

`MEMORY_RERANK_URL` 直接填写包含 WorkspaceId 的完整百炼模型地址，例如
`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks`。请求采用兼容接口的顶层
`model/query/documents/top_n/instruct` 结构。

准入阈值不提供默认值。先用真实用户记忆建立一个本地 JSON 标注集：

```json
{
  "cases": [
    {
      "id": "diet-dislike-1",
      "query": "我讨厌吃什么",
      "expectedKeys": ["diet:food:折耳根", "diet:food:香菜"]
    }
  ]
}
```

然后运行：

```bash
npm run test:memory-rerank-threshold -- \
  --dataset ./artifacts/memory-rerank-labels.json \
  --user-id '<真实用户 UUID>' \
  --out ./artifacts/memory-rerank-threshold-report.json
```

脚本强制使用 `always` 模式、关闭 `touch`，扫描真实候选分数并输出每个阈值的
Precision / Recall / F1、FP、FN 和未进入 rerank 池的相关 key。它只给出评估报告，
不会自动改写 `MEMORY_RERANK_ADMIT_THRESHOLD`；上线阈值必须结合误召回和漏召回成本人工确认。

### 技术选型与决策

- **不给记忆表建倒排索引**（不用 tsvector 生成列 + GIN）。RAG 侧那套是为几十万行的表设计的；
  记忆表过完 `user_id` 过滤后只剩单个用户的几百条短文本，顺序扫 + 子串匹配是微秒级。
  建索引买不到可测量的延迟收益，只买来维护面。同理排除了 `zhparser`/`pg_jieba`（Supabase
  托管版没有）、bigram tsvector（只对索引有意义）、`pg_trgm`（CJK 选择性差）。
  额外白送的好处：**写入侧不需要任何配套改动**，`content` 不必事先分词。
- **切词放应用层，不让数据库切**。SQL 那边能用的只有 `regexp_split_to_table(query, '\s+')`
  与 `to_tsvector('simple')`，两者对中文都是整句一个 token —— 于是「关键词命中」退化成
  「原文必须一字不差出现整句」，实际永不命中。
- **`strpos` 而不是 `LIKE`**。term 来自用户输入，插进 LIKE 模式里的 `%` / `_` 会变成通配符
  （问「50%」会匹配所有以 50 开头的内容）。`strpos` 没有元字符，也就没有「忘了转义」这回事。
- **停用词表是必需的，不是优化**。没有它，「我」「的」「是」「多少」会命中几乎每一条记忆，
  `overlap_rank` 全是高分，通道从「区分信号」变成「噪声发生器」—— 比不做这个通道更糟，
  因为它把无关记忆抬到了与相关记忆同一档。表里刻意**不**收 预算 / 过敏 / 城市：
  它们频率高，但正是用来区分槽位的。
- **数字只抽裸数字，不带单位**。记忆里写的是「8 万」（中间有空格）、用户问的是「8w」，
  粘上单位两边都对不上；裸 `8` 能同时命中两种写法。代价是「8」也会命中「18 万」——
  这是打分通道不是过滤通道，真正相关的那条会命中更多 term 而排在前面。
- **`MAX_TERMS` 的作用不只是省 CPU**。`overlap_rank` 的分母是 term 总数，
  一句长提问会把真正相关那条记忆的分数摊薄到接近 0。截断保住区分度。
- **准入看通道原始分，排序看融合分**。这两者不能互换：以 weighted 为例，关键词没命中时
  融合分约为 `0.7 × 校准向量分`，一条相似度 0.75 的记忆融合后掉到 0.5 出头，
  低于 0.68 的阈值被丢掉 —— **开启融合等于顺手抬高了召回门槛**，而且没有任何测试会失败，
  只是记忆悄悄变少了。
- **两阈值拆分必须跟在关键词通道之后**。`match_memories` 是 `ORDER BY 距离 LIMIT match_count`
  （先排序再截断），单独把入口阈值降到 0.7× 返回的仍是同一批最近邻，只在队尾多挂几条低分行，
  随后被严过滤全部淘汰 —— 进 prompt 的 top-3 一个字都不会变。有了关键词通道，
  队尾那些低向量分的条目才可能因关键词命中被救回来。
- **融合策略不预设赢家**。`weighted` 的理由（候选池只十几条、只取 top-3、条目极短，
  所以 0.92 与 0.71 的量级差有意义，被 RRF 压成相邻序数是净损失）是推理不是数据。
  [memory-fusion-eval.ts](../../../scripts/memory-fusion-eval.ts) 跑满三组含 `vector_only`
  对照组；增量小于噪声时整节都不该留。A/B 集里**必须有负例**：关键词通道天然倾向多召回，
  只跑正例一定得出「全面变好」，代价恰好落在负例上。
- **`calibrateMemoryListScore` 是复制而不是 import**。原函数是
  `lib/knowledge/retriever.ts` 的模块内私有函数，其模块加载会拉起整条 RAG 配置链路
  （ragConfig / embedding / supabase）。记忆召回不该为一个 3 行的算术函数背上这些依赖。
  代价是两处要一起改 —— 所以在两边都留了注释。
- **保留期按类型分档，按 `superseded_at` 判过期**
  （[history-cleanup.ts](../../../lib/agent/memory/history-cleanup.ts)）。
  用 `effective_to` 会删错一类行：correction 归档的行 `effective_to == effective_from`，
  可能是很久以前的时间点，但它是**刚刚**才被记为误记的 —— 恰恰是最该留着的行。
  清理脚本默认 dry-run，要真删必须显式 `--apply`：这里删的是不可恢复的用户历史，
  不是可重新生成的产物。

## 踩坑记录

- **加参数的 `CREATE OR REPLACE FUNCTION` 不是替换，是新建重载**。`upsert_memory` 从 13 个参数
  加到 17 个，旧的 13 参数版本仍然存在；Supabase RPC 走命名参数调用，数据库拿到两个候选会报
  `PGRST203: Could not choose the best candidate function`，记忆写入全线失败，
  而报错信息与「归档」毫无关系。**必须先 `DROP FUNCTION` 旧签名。**
- **service-role 绕过 RLS，`ENABLE ROW LEVEL SECURITY` 当前拦不住任何东西**。
  `lib/platform/supabase.ts` 用的是 `SUPABASE_SERVICE_ROLE_KEY`，DB 层
  `auth.uid() = user_id` 策略是「将来切到 anon/authenticated client 时的第二道防线」。
  当前唯一的防线在应用层，所以每个新 RPC 内部都要 `p_user_id IS NULL` 时**返回空集而不是全表**。
- **`match_memories` 不返回 `version`**。所以 `MemoryRecord.version` 是可选的，
  写入时拿不到版本号就退回 `FOR UPDATE` 序列化，而不是猜一个值传进去。
- **`keyword_rank` 不会自动进 `score`**。`record-mapper` 只认 `similarity` 列，
  关键词通道的分数要在 `recallByKeyword` 里手动补进 `record.score`。
- **`recallByKeyword` 吞掉 RPC 错误返回 `[]`，是刻意的**。迁移还没跑（RPC 不存在）时
  整条召回链路必须仍然可用，退化成纯向量。
- **`textScore = 0` 是常态，不是通道失效**。中文常见词本来就经常不命中；
  别据此下调 `vectorWeight`。它也让默认值切换是安全的：keywordScore 为 0 时，
  weighted 的排序与纯向量**单调等价**。
- **`Intl.Segmenter` 的迭代器需要 `Array.from` 包一层**。项目 `tsconfig.json` 没有显式
  `target`，直接 `for...of` 迭代 `matchAll` / `segment()` 的结果会报 TS2802
  （downlevelIteration）。同理 `Map` 的解构迭代改成 `.forEach`。
- **切词器要能力检测并静默降级**。拿不到 `Intl.Segmenter` 时中文那一路回到
  「只有数字 / Latin / 受控 key」的形态，而不是让整条召回链路抛异常。
  降级的后果是中文专名召不回，不是召回错的。
- **保留期是有损的，损在 `truth_as_of` 上**。历史行删掉之后，问「我去年这时候预算多少」
  会得到「那时没有任何记录」，而正确答案是「记录已过保留期」——这两者在工具返回值里
  目前**不可区分**。这是保留期这个决定本身的代价，不是 bug，所以默认保留期取得偏长。
- **A/B 跑分器必须逐 case 独立种子 + 独立清理**。多条 case 共用 `budget:car` 这类 key，
  混在一起跑会让某条 case 的种子变成另一条的干扰项，结果不可复现。

## 延伸阅读

- [分层记忆架构](./layered-memory.md) — 记忆整体架构
- [记忆双写原子性](./memory-atomic-dual-write.md) — `upsert_memory` 的前身
- 迁移：[20260804-memory-history.sql](../../schemas/migrations/20260804-memory-history.sql)、
  [20260804-memory-keyword-channel.sql](../../schemas/migrations/20260804-memory-keyword-channel.sql)
- eval 基线：[memory.ts](../../../lib/agent/eval/datasets/memory.ts)
  （`known_red` 的 case **红本身是正确状态**，必须写明 `unblockedBy`，
  否则无法区分「还没做」与「做完了但坏了」）
- 跑分与运维脚本：`npm run test:memory-fusion -- --user-id <uuid>`、
  `npm run memory:history:cleanup`（默认 dry-run）
