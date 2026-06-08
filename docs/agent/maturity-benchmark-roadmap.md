# 对标成熟 Agent 的能力升级路线图（记忆 / 上下文 / Harness）

> 这是一份**对标 + 规划**文档，不是单功能学习笔记。
>
> 背景：项目已落地 Agent Loop、三层记忆、Trace、Eval、结构化事件、Token 预算等基础能力（见 [agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md)）。本文回答的是下一个问题——**在记忆系统、上下文工程、Harness 工程三个方向，对标 mem0 / Zep / Generative Agents / Claude Code / Anthropic 官方实践 / LangSmith 等成熟方案，还差什么、怎么补、面试怎么讲。**
>
> 调研方式：多 Agent 并行调研（记忆 / Harness 两方向由专项 agent 完成 Web 对标，上下文工程方向由 lead 基于代码实锤 + Anthropic 官方实践补齐）。所有「本项目现状」均为**代码事实**，已锚定真实文件行号。

---

## 总览：现在处在哪

| 方向 | 已做（优势） | 性质判断 |
|---|---|---|
| 记忆 | 三层架构（session/longterm/semantic）+ LLM 抽取 + 向量召回 | 有存储，**缺生命周期管理层**——正是 mem0/Zep/Letta 的核心卖点 |
| 上下文 | TokenBudget + 工具结果截断 + 滚动压缩骨架 | 框架对，但 **compaction 是暴力截断（隐藏 bug）+ 零 prompt caching** |
| Harness | Trace 落库 + Eval 双轨 + 结构化事件协议 | **trace 基建已领先多数面试项目**，缺 LLM-as-judge / 错误恢复 / 并发 |

**评分口径**：实现成本 S（半天）/ M（1-2 天）/ L（3 天+）；面试杀伤力 高/中/低。

---

## 一、记忆系统

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| 抽取 | [memory-flow.ts:63-114](../../lib/agent/memory/memory-flow.ts) `consolidate()` | 对话后异步调 LLM，JSON prompt 让模型自由生成 `fact`+`key` |
| 写入 | [memory-flow.ts:98-103](../../lib/agent/memory/memory-flow.ts) | 双写 longTerm+semantic，两边 `onConflict:"key"` upsert |
| 冲突处理 | [semantic-store.ts:48-51](../../lib/agent/memory/semantic-store.ts) | **唯一"合并"就是 SQL key 相同则覆盖**。LLM 自由生成 key → 同事实换 key 就并存，无语义级 ADD/UPDATE/DELETE |
| 召回 | [memory-flow.ts:28-38](../../lib/agent/memory/memory-flow.ts) | 向量检索，**固定 limit=5、阈值默认 0.3**，命中全拼成 system 注入。无重排、无动态阈值 |
| Schema | [types.ts:3-11](../../lib/agent/memory/types.ts) | id/key/layer/content/metadata/score?/createdAt。**无 type、importance、last_accessed、access_count、valid/invalid** |
| 遗忘 | 无 | 只有手动 forget，无衰减/TTL/容量上限 |
| 用户可控 | 无 | 无查看/编辑出口，无 provenance 溯源 |

**一句话**：当前是"按 LLM 自拟 key 去重的向量 KV 存储"，缺一个"记忆生命周期管理层"。

### 对标表（六维 × 五产品 × 本项目）

| 维度 | mem0 | Letta/MemGPT | ChatGPT/Claude | Generative Agents | Zep/Graphiti | 本项目 |
|---|---|---|---|---|---|---|
| 抽取 | 两阶段，抽取只用当前 msg pair+summary | 不抽取，Agent 自调 append/replace | Claude 周期性 synthesis | LLM 给 importance 打分 | 抽 fact+时间 | 抽 fact+key |
| 冲突更新 | **ADD/UPDATE/DELETE/NOOP**，LLM 当 controller，先召回相似再决策 | 自编辑 memory_replace | 自动解决矛盾 | 无（纯追加） | **bi-temporal 边失效**，旧事实标 invalid 不删 | **仅 key 相同则覆盖** |
| 检索策略 | top-k 向量+拼接 | core 常驻无需检索 | synthesis 常注入 | **三因子 recency·γ^Δt+importance+relevance** | semantic+keyword+graph 混合 | 固定 top-5 阈值 0.3 无重排 |
| 记忆类型 | episodic/semantic/偏好 | core/recall/archival 三层 | saved vs chat history | observation/reflection | entity/fact/episode | 仅 layer 区分存储层 |
| 遗忘机制 | UPDATE/DELETE 显式 | paging 换入换出 | 容量满淘汰/可 reset | **recency 指数衰减 γ=0.995/小时** | 软失效不删 | 无 |
| 用户可控 | API 增删查 | Agent 自管 | **可视化列表+可编辑+溯源** | N/A | 全程 provenance | 无 |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **M1** | **ADD/UPDATE/DELETE/NOOP 冲突决策** | mem0 | `memory-flow.ts:98` LLM 自拟 key 做 upsert，事实演化时新旧并存 | M | **高** |
| **M2** | **valid/invalid 软失效（替代硬删）** | Zep bi-temporal | DELETE 真删丢历史 | M | **高** |
| **M3** | **召回：多召→重排→截断（三因子）** | Generative Agents | `memory-flow.ts:32` 固定 top-5 + 阈值 0.3，无重排 | M | **高** |
| M4 | schema 加 type/importance/last_accessed/access_count | GA + mem0 | `types.ts` 无这些字段，M3 无数据可用 | M | 中 |
| M5 | 抽取传完整 transcript（user+assistant+工具结果） | mem0 | `route.ts:163` 只传本轮 user 消息（已核实） | **S** | 中 |
| M6 | 记忆可视化 + provenance 溯源 | ChatGPT/Claude | 无查看/编辑出口 | L | 中 |

**改法要点**：
- **M1**：`consolidate()` 抽取后、写入前插一个 update 阶段——每条 fact 先 `semantic.recall(fact,5)` 拿相似旧记忆，把"新 fact + 候选旧记忆（带 id）"喂决策 prompt 返回 `{op,target_id}`，按四操作分支执行。存储层不动，`memory-flow` 加 `decideOp()`。
- **M2**：DELETE 改 `update(key,{valid_to:now})`；召回默认只查 `valid_to is null`；保留历史可追溯。
- **M3**：recall 放宽到 20-30；在 `recallForPrompt` 里对每条算 `score = w_r·relevance + w_i·importance + w_t·recency`（recency 用指数衰减），排序取 top-k；重排出错 fail-open 回退余弦序。
- **M5**：把 `route.ts:163` 的 `consolidate(messages,...)` 改成传 `agentLoopResult.loopMessages`（完整 transcript），`memory-flow` 这侧 transcript 拼接已支持任意 role，近乎零改动。

**串做组合（面试故事最完整）**：M1+M2 = "记忆冲突与演化"；M3+M4 = "为什么不是固定 top-5"。

---

## 二、上下文工程

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| 压缩 | [compaction.ts:32-36](../../lib/agent/runtime/compaction.ts) | 超阈值时保留首条+最近 4 条，中间消息 `JSON.stringify().slice(0,300)` **暴力截断**拼成"摘要" |
| token 计量 | [budget.ts:57](../../lib/agent/runtime/budget.ts) | `char/4` 粗估，中文误差大 |
| 真实 usage | [runtime/index.ts:366](../../lib/agent/runtime/index.ts) | trace 里**已记录真实 `input_tokens`**，但 budget 没用它校准 |
| prompt 组装 | [runtime/index.ts:125](../../lib/agent/runtime/index.ts) | system 字符串直接拼接，每轮整段重传 |
| prompt caching | 无 | **`cache_control` 零命中**，system+工具定义每轮整段重传 |

### 对标表

| 维度 | 成熟做法 | 本项目现状 | 差距 |
|---|---|---|---|
| 压缩策略 | Claude Code auto-compact：调 LLM 把早期轮次摘要成连贯段落 | 暴力截断半句话 | **大（实为 bug）** |
| token 计量 | 真实 tokenizer / 模型返回 usage | char/4 估算，未用已有真实值 | 中 |
| prompt 组装 | 分层（身份/记忆/RAG/工具说明），各部分预算独立 | 字符串硬拼 | 中 |
| 缓存利用 | Prompt Caching 给稳定前缀（system/工具定义）打 `cache_control` | 零缓存，每轮重传 | **大** |
| 上下文隔离 | sub-agent 隔离上下文（Anthropic context eng） | 单 loop | 小（按需） |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **C1** | **compaction 改 LLM 摘要式** | Claude Code auto-compact | `compaction.ts:32` `slice(0,300)` 暴力截断，**喂半句话给模型（隐藏 bug）** | M | **高** |
| **C2** | **Prompt Caching（cache_control）** | Anthropic Prompt Caching | 零命中，system+工具定义每轮整段重传，8 轮 loop 浪费巨大 | **S** | **高** |
| C3 | token 计量用真实 usage 校准 | — | `budget.ts:57` char/4，`index.ts:366` 已有真实 `input_tokens` 没用 | S | 中 |
| C4 | Prompt 分层组装管道 | Anthropic context eng | system 字符串硬拼，身份/记忆/RAG/工具混一起 | M | 中 |

**重点说 C1+C2**：
- **C1** 现在严格说是 bug——`JSON.stringify().slice(0,300)` 把早期消息切成半句乱码喂回模型。正解：调一次廉价 LLM 把早期轮次摘要成连贯段落（Claude Code 的 auto-compact 思路）。面试话术：「暴力截断破坏语义连续性，模型看到半句话反而被误导；LLM 摘要式压缩在成本和保真之间取平衡。」
- **C2** 性价比之王（成本 S、杀伤力高）：8 轮 loop 每轮把 system + 全部工具定义重传，Anthropic prompt caching 给稳定前缀打 `cache_control`，缓存命中部分约 1/10 价格 + 更低延迟。面试话术：「多轮 loop 里 system 和工具定义是稳定前缀，用 prompt caching 给它打缓存，长对话省成本省延迟。」

---

## 三、Harness 工程

### 本项目现状（代码基线）

| 环节 | 代码位置 | 实际做法 |
|---|---|---|
| Agent Loop | [runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop` | 反应式多轮，maxToolIterations=8，token budget 兜底 |
| Trace | [trace.ts](../../lib/agent/runtime/trace.ts) + [trace-store.ts](../../lib/agent/runtime/trace-store.ts) | AgentTrace（model/tool step，带 usage/duration/cost）落库 Supabase |
| Eval | [eval/cases.ts](../../lib/agent/eval/cases.ts) | **仅 3 条用例，断言全结构化**（shouldCallTool/shouldComplete/...），无 LLM-as-judge |
| 错误处理 | [runtime/index.ts:202](../../lib/agent/runtime/index.ts) | 工具失败直接回灌让模型自处理，无重试/无瞬时 vs 永久区分 |
| 重复检测 | [runtime/index.ts:386](../../lib/agent/runtime/index.ts) | 命中即终止整个 loop，可能误杀合理重复 |
| 工具执行 | [runtime/index.ts:151](../../lib/agent/runtime/index.ts) | 串行 `await` |

### 对标表

| 维度 | 成熟做法 | 本项目现状 | 差距 |
|---|---|---|---|
| 可观测 trace | LangSmith/LangFuse 结构化调用树 | 已有 trace.ts/trace-store.ts | **小（优势）** |
| 评测 eval | LLM-as-judge + 回归数据集（LangSmith/Braintrust） | 仅 3 条全结构化断言 | **大（最大缺口）** |
| 错误恢复 | transient/permanent 分类 + 退避重试 + 降级（OpenAI guardrail/OpenHands） | 失败直接回灌 | 中 |
| 重复检测 | stuck 阈值化，同工具不同参放行（OpenHands） | 命中即终止 | 中 |
| 规划 | 长程任务才上 plan（Anthropic Building effective agents） | 纯反应式 | 小~无 |
| 并发 | Promise.all 并行无依赖工具 | 串行 await | 中 |

### 改进项

| # | 改进项 | 对标 | 当前缺口 | 成本 | 杀伤力 |
|---|---|---|---|---|---|
| **H1** | **LLM-as-judge eval** | LangSmith/Braintrust | `eval/cases.ts` 仅 3 条全结构化，无质量打分 | M | **高** |
| **H2** | **工具错误恢复（transient/permanent + 重试 + 降级）** | OpenAI guardrail/OpenHands | `index.ts:202` 失败直接回灌，无重试 | S~M | **高** |
| H3 | 重复检测→stuck 阈值化（同工具不同参放行） | OpenHands | `index.ts:386` 命中即终止整 loop | S | 中 |
| H4 | 工具并发 Promise.all | — | `index.ts:151` 串行 await | S | 中 |
| ❌ | ~~Planning / 子任务分解~~ | — | 纯反应式 | — | **建议不做** |

**关键洞察**：
- **H1** 复用已有 trace 基建——judge 直接吃 `trace.steps` 结构化对象打分（不用 parse 日志），judge model + rubric 钉进 git 与被测模型解耦，RAG case 用 `toolSources` 做 faithfulness 校验。
- **❌ Planning 刻意不做**：学术结论 3-4 步任务上 planning 是负优化（Anthropic「能不上 agent 就不上」）。「为什么不上 planning、坚持 ReAct 甜区」反而是面试加分论点。

---

## 推荐落地顺序（跨三方向，按性价比）

**第一梯队（高杀伤力，优先做）：**
1. **C2 Prompt Caching**（S/高）— 改动最小、立竿见影，先摘果子
2. **C1 LLM 摘要式 compaction**（M/高）— 修隐藏 bug，上下文工程最硬一课
3. **M1+M2 记忆冲突决策 + 软失效**（M+M/高）— 记忆系统最经典面试题
4. **H1 LLM-as-judge**（M/高）— 让"可度量"从口号变 demo

**第二梯队：** M3+M4 三因子检索 · H2 错误恢复 · M5（顺手 S）· C3 真实 usage 校准

**口头讲（不必实现）：** M6 记忆可视化 · ❌ 为什么不上 Planning

> 每项都建议独立产出一篇 `docs/` 学习笔记，且都对应一道高频面试题。

---

## 延伸阅读（对标来源）

- **mem0**：[Overall Architecture](https://medium.com/@zeng.m.c22381/mem0-overall-architecture-and-principles-8edab6bc6dc4) · [Dwarves breakdown](https://memo.d.foundation/breakdown/mem0)
- **Letta/MemGPT**：[Letta Docs](https://docs.letta.com/concepts/memory-management/) · [vectorize 对比](https://vectorize.io/articles/mem0-vs-letta)
- **Generative Agents**：[arXiv 2304.03442](https://arxiv.org/pdf/2304.03442)（三因子检索 recency·importance·relevance）
- **Zep/Graphiti**：[arXiv 2501.13956](https://arxiv.org/abs/2501.13956) · [getzep/graphiti](https://github.com/getzep/graphiti)（bi-temporal 软失效）
- **ChatGPT/Claude Memory**：[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq) · [Claude 记忆](https://support.claude.com/en/articles/11817273)
- **Anthropic**：Building effective agents · Effective context engineering for AI agents · Prompt Caching 文档
- **Eval 工业做法**：LangSmith / LangFuse / Braintrust（LLM-as-judge + 回归数据集）
- 本项目已有：[agent-loop-interview-summary.md](./agent-loop-interview-summary.md) · [agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md)
