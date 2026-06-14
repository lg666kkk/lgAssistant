# 联网搜索上下文优化方案

## 为什么这是个问题

搜索工具与其他工具不同——它的结果大小是不可控的外部变量。一次搜索可以返回 500 字，也可以返回 15000 字，完全取决于网页内容和搜索深度。这个不确定性会直接传导给模型上下文：

- 单次搜索吞掉大量 context window，后续轮次可用空间减少
- 低质量、重复、无关内容混入，干扰模型推理
- trace 和前端展示被大量原始文本淹没，可读性差
- token 成本线性膨胀，多次搜索尤其明显

核心目标不是”把更多网页塞给模型”，而是：

1. **搜得准**：查询词、时间范围贴近用户意图，从源头减少噪声
2. **取材稳**：过滤广告、聚合页、重复转载
3. **喂得少**：进入模型的是提炼后的 evidence，不是原始网页堆叠
4. **可追溯**：回答中的关键事实能回到来源 URL、标题、时间

## 通用完整方案（脱离具体项目）

### 阶段 0：搜索前——Query Planning

这是最容易被忽视但收益最高的环节。垃圾进垃圾出，查询词精准，后续所有处理都会变简单。

**0.1 查询改写（Query Rewriting）**

不要把用户的原始问题直接丢给搜索引擎。让模型先把问题转化成搜索词：

```
用户：苹果最新手机怎么样
改写：iPhone 16 Pro review 2025 pros cons
```

实现方式：在 system prompt 里要求模型”先思考搜索词再调工具”，或在工具 description 里说明。

**0.2 查询分解（Query Decomposition）**

复杂问题拆成多个子查询分别搜索：

```
原始：React 和 Vue 在 2024 年的生态和性能对比
子查询 1：React ecosystem state 2024
子查询 2：Vue 3 performance benchmark 2024
```

代价是多次工具调用，适合研究类场景，不适合简单问答。

**0.3 时效性约束**

查询词显式带上时间，或使用搜索 API 的时间过滤参数：

```
原始：Python 最佳实践
改写：Python best practices 2025
```

Tavily 支持 `days` 参数按发布时间过滤，对新闻/价格/版本类问题效果显著。

**0.4 完整 Query Plan 结构**（适合高级 Agent）

把搜索意图结构化，让工具调用更精准：

```json
{
  “query”: “NVIDIA Q2 2025 earnings report revenue”,
  “intent”: “financial_data”,
  “freshness”: true,
  “timeRange”: “past_week”,
  “sourcePreference”: [“official”, “major_financial_media”],
  “avoid”: [“forum”, “unverified_rumor”]
}
```

---

### 阶段 1：搜索执行——参数控制

搜索工具本身的参数配置也是优化手段：

- **结果数量**：默认 5 条，不要贪多。相关性好的 3 条比泛泛的 8 条更有用
- **搜索深度**：普通事实用 `basic`，研究类用 `advanced`（`advanced` 会抓取网页全文，结果更长但更准）
- **时间范围**：新闻/价格/版本/政策类必须限时间
- **来源限制**：如果 API 支持 include/exclude domain，优先用结构化参数而非自然语言

---

### 阶段 2：原始结果处理——Normalize & Filter

搜索结果进入下一步前，先做标准化和过滤。

**2.1 结构化标准格式**

```ts
type SearchCandidate = {
  title: string;
  url: string;
  domain: string;        // 从 url 提取的 hostname
  snippet: string;       // 截断后的摘要
  publishedAt?: string;
  score?: number;        // 搜索 API 返回的相关度分
  sourceType?: “official” | “media” | “docs” | “social” | “aggregator” | “unknown”;
};
```

**2.2 去重**

| 去重维度 | 实现成本 | 说明 |
|----------|----------|------|
| URL 精确去重 | ★☆☆ | 完全相同的 URL 直接丢弃 |
| Domain 去重 | ★☆☆ | 同一 domain 只保留 score 最高的 1 条 |
| 标题相似去重 | ★★☆ | 字符串相似度 > 0.8 视为重复 |
| 内容相似去重 | ★★★ | n-gram 或 embedding，成本高 |

**2.3 质量过滤**

```
保留条件：
- title 非空
- url 合法
- snippet 长度 >= 80 字
- domain 未被列入黑名单

降权或丢弃：
- snippet 极短（< 30字），通常是导航页/聚合页
- 标题含大量营销词（”最好的”、”推荐”、”免费下载”）
- domain 本轮已出现超过 2 次
- 发布时间明显过旧且问题要求最新内容
```

---

### 阶段 3：重排——Reranking

选出最值得进入模型上下文的 Top-K 结果。

**策略从轻到重：**

1. **搜索 API 原始排序**：直接使用 API 返回的 score 排序，零成本
2. **规则打分**：对多个维度加权打分，可解释，无额外依赖
3. **Embedding 相似度重排**：用向量模型计算 query 与 snippet 的相似度，需要向量模型
4. **Cross-encoder / LLM rerank**：效果最好，但需要一次额外的模型调用

**规则打分参考：**

```
finalScore =
  searchScore × 0.4          # API 原始相关度
  + authorityBonus × 0.2     # 官方/权威来源加分
  + freshnessBonus × 0.2     # 时间新鲜度
  + entityMatchBonus × 0.1   # 摘要包含查询关键实体
  + diversityBonus × 0.1     # 来源多样性
  - duplicatePenalty
  - lowQualityPenalty
```

**实践中**：对大多数应用，搜索 API 的原始 score 已经足够。引入复杂 rerank 前，先看 API 原始排序的质量。

---

### 阶段 4：压缩——Evidence Compression

**这是最核心的优化**。不把原始长摘要塞进模型，而是压缩成结构化的 evidence card。

**4.1 硬截断（最简单）**

每条 snippet 限制字数，不超过 300 字。  
缺点：截断位置不智能，可能丢关键信息。

**4.2 结构化 Evidence 格式（推荐）**

```
[1] iPhone 16 Pro 深度评测：A18 Pro 芯片性能测试
来源：theverge.com | 2025-09-15
链接：https://theverge.com/...
要点：A18 Pro 比上代快 15%，散热优化明显，相机新增微距模式，起价 999 美元。
```

**压缩规则：**
- 每条 evidence 控制在 100-300 字
- 总 evidence 控制在 800-1500 tokens（5 条结果应远不超过这个量）
- 保留硬事实：数字、日期、实体名、版本号、价格
- 删除套话：背景介绍、营销语、重复描述
- 冲突信息保留，不强行合并（让模型自己判断）

**4.3 LLM 摘要压缩**

搜索结果太复杂时，用轻量模型生成针对用户问题的简报：

```
输入：原始搜索结果（3000字）+ 用户原始问题
处理：haiku/mini 模型生成简报
输出：200字，直接回答用户问题的关键信息
```

优点：信息密度最高，主模型推理质量好。  
缺点：多一次模型调用（延迟 +1-2s，费用增加）。

---

### 阶段 5：上下文分层——Model Context vs UI Sources

搜索结果应该产出两个不同的输出，服务不同消费者：

```
原始搜索结果
    ↓
┌──────────────────────┬──────────────────────┐
│  model context       │  UI / trace sources  │
│  (compact evidence)  │  (full metadata)     │
│  ─────────────────   │  ─────────────────   │
│  结构化摘要           │  完整标题             │
│  ~800 tokens         │  URL                 │
│                      │  原始摘要             │
│                      │  score、时间          │
└──────────────────────┴──────────────────────┘
```

不要为了展示 UI 来源，把完整搜索结果都塞进模型上下文。这是最常见的浪费。

```ts
type WebSearchOutput = {
  content: string;           // compact evidence，进入 tool_result
  sources: SearchCandidate[]; // 完整 metadata，给 UI/trace
  raw?: unknown;             // 调试用，不进上下文
};
```

---

### 阶段 6：二阶段搜索——Search + Fetch

这是一种工具架构级的优化，来自 Perplexity、Claude 等商业产品：

```
工具 1：web_search → 只返回 title + url + 50字摘要（”目录扫描”）
工具 2：web_fetch  → 精读某条 URL 的完整内容（”按需精读”）
```

模型先用 web_search 扫描，判断哪条最相关，再用 web_fetch 精读 1-2 条。

**为什么总 token 反而更少？**

- 大多数搜索，”目录级”信息就够了（5条 × 50字 = 250字）
- 需要深读时，只精读 1 条（~2000字）
- 而不是默认把所有 5 条完整摘要都塞进上下文（~8000字）

**缺点**：需要实现 web_fetch 工具，涉及 HTML 正文提取（cheerio/readability）。

---

### 阶段 7：多轮搜索积累——Search Context Accumulation

Agent 可能在一次 loop 里连续搜索多次。如果每次都把搜索结果 append 进 messages，会指数级膨胀：

```
第1次搜索 → 1000字结果 append
第2次搜索 → 再 append 1000字
第3次搜索 → 再 append 1000字
...
```

更好的方案是在 loop 内维护一个搜索上下文池：

```
SearchPool {
  candidates: SearchCandidate[]  // 跨次搜索去重合并
  lastCompactDigest: string      // 当前 pool 的压缩摘要
}

每次新搜索：
  新结果 → 进入 pool → 去重 → 重排 → 重新生成 compact digest
  tool_result.content = 最新的 compact digest（覆盖而非追加）
```

把”多次搜索 = 多坨 tool_result”变成”多次搜索 = 一个逐步完善的 evidence set”。

---

### 阶段 8：回答生成约束——Grounded Answering

最后一环，通过 prompt 约束回答质量：

- 只把搜索 evidence 支持的内容当作事实
- 推断、判断、建议单独标明
- 来源冲突时说明冲突
- 数据不足时说明缺口
- 时间敏感问题标明检索时间或资料时间

## 成熟度分层

| 阶段覆盖 | L1 基础可用 | L2 稳定可靠 | L3 研究增强 | L4 生产级 |
|----------|-------------|-------------|-------------|-----------|
| 阶段0 Query Planning | 无 | 查询改写 | 查询分解 | 完整 Query Plan |
| 阶段1 参数控制 | 限条数 | 限条数+时间 | 动态深度 | 多策略选择 |
| 阶段2 Normalize | 截断 | 去重+格式化 | 质量过滤 | 来源标签+黑名单 |
| 阶段3 Reranking | API 原始排序 | 规则打分 | Embedding | Cross-encoder |
| 阶段4 压缩 | 硬截断 | 结构化 evidence | LLM 摘要 | 自适应压缩 |
| 阶段5 分层输出 | 无 | sources 分离 | trace 指标 | 完整可观测 |
| 阶段6 二阶段搜索 | 无 | 无 | 有 | 有+缓存 |
| 阶段7 搜索积累 | 无 | 无 | 有 | 有+持久化 |
| 阶段8 Grounded 回答 | 无 | Prompt 约束 | 冲突检测 | 引用级校验 |

**L1**：个人助手、轻量工具、早期 Agent  
**L2**：默认开启联网搜索的生产助手  
**L3**：深度研究、财经分析、政策/法律/技术调研  
**L4**：商业搜索产品、企业知识助手

## 结合本项目的落地选择

### 项目现状诊断

**已有的好基础：**
- Tavily 返回的 `content` 已是提取后的摘要，不是原始 HTML（不需要 HTML 解析层）
- `truncateToolContent(2000)` 在工具路由层有兜底截断
- trace 记录 model/tool step，前端已有来源展示能力
- `compactLoopMessages` + `TokenBudget` 上下文管理机制完整

**当前主要短板：**
- `web_search` 的 raw results 直接拼成长文本进入 `tool_result.content`，5条结果可能 5000-15000字
- 拼接粒度是"全量结果整体"，而不是"每条结果独立控制"
- `web_search` 的结果没有像 `search_notes` 一样提取 sources 给前端展示
- 工具级 token 预算没有区分工具类型，web_search 应该比其他工具预算更小
- 没有 domain 去重，同一站点可能刷屏

**当前不需要做的：**
- LLM 摘要压缩（Tavily 已做提取，二次压缩收益低，延迟和费用不值）
- Embedding rerank（API 原始 score 已够用，引入向量模型成本高）
- 网页正文抓取（Tavily 已处理，除非明确需要完整网页内容）
- 搜索上下文积累池（先看多次搜索的实际频率，过度设计）

### 分阶段落地

**Phase 1：工具内压缩和去重**（改动：`lib/agent/tools/web-search.ts`）

目标：
- 按 Tavily score 降序排，只取 Top-4
- 每条 snippet 截到 300 字
- URL 精确去重 + domain 去重（同 domain 最多 1 条）
- 输出结构化 evidence 格式，替代现在的松散拼接

建议输出格式：
```
搜索：{query}

[1] 标题
来源：example.com | 2025-06-12
链接：https://example.com/...
摘要：...（300字以内）

[2] ...
```

预期效果：单次 web_search 的 tool_result.content 从 5000-15000 字降到 ~1200 字。

**Phase 2：sources 分离**（改动：`lib/agent/runtime/index.ts` 的 `executeTools`）

目标：
- `web_search` 成功时，把搜索结果提取为 `ToolSourceType` 数组
- 前端来源区域展示联网搜索来源卡片，而不是只在工具调用日志里看 URL
- `tool_result.content` 继续保持 compact digest，不因 UI 需求膨胀

注意：当前 `ToolSourceType` 有 `notionPageId` 字段，复用时填空字符串，后续再泛化。

**Phase 3：工具级 token 预算**（改动：`lib/agent/runtime/index.ts` 的 `executeTools`）

当前兜底截断对所有工具统一 2000 tokens，web_search 应该更严格：

```ts
const maxToolTokens = toolUse.name === "web_search" ? 1000 : 2000;
```

进一步可在 tool definition 里加 `contextBudgetTokens?: number` 字段，让每个工具自己声明预算。

**Phase 4：Prompt 搜索策略增强**（改动：`lib/agent/prompt/segments.ts`）

在 web-search-policy 段补充：
- 时间敏感问题（新闻/价格/版本）必须把时间范围写进查询词
- 优先使用英文搜索词（Tavily 对英文召回质量更高）
- 避免泛泛的长句，提取核心实体和动作

**暂缓（Phase 5+）：**
- 搜索上下文积累池：等发现同一轮多次搜索问题明显时再做
- 二阶段搜索（web_fetch）：等有深度研究场景需求时再做

## 评估指标

建议 trace 中逐步补这些指标：

- `rawResultCount`
- `keptResultCount`
- `dedupedCount`
- `rawChars`
- `compactChars`
- `contentTruncated`
- `sourceDomains`
- `searchQuery`
- `searchDepth`

手工 eval 可以先用这些 case：

1. 最新新闻：是否搜索，是否给出时间。
2. 技术版本：是否优先官方文档。
3. 财经行情：是否避免过期数据。
4. 多来源冲突：是否说明不确定性。
5. 泛问题：是否不会连续无意义搜索。

## 结论

完整方案的核心是：

```txt
过滤噪声 -> 提炼精华 -> 结构化组织 -> 来源分离 -> 控制预算
```

对当前项目，最佳路径不是马上引入复杂 RAG，而是先把 `web_search` 从”原始搜索结果拼接器”升级成”compact evidence 生成器”。

优先级：

1. `web_search` 内部 normalize/dedupe/compact。
2. `web_search` 工具级 token 预算。
3. 联网 sources 与 model context 分离。
4. trace 指标补齐。
5. 后续再考虑 rerank、summarizer、accumulator。

---

## 实战问题记录

### [2026-06-14] 同一意图被搜索三次——并发工具调用导致时间错误

**现象**

用户问”近期伊朗新闻”，trace 里出现三次 `web_search` 调用，query 分别是：
- `”2025年7月 最新国际新闻 热点”`（错误年份）
- `”2026年6月 国际新闻 热点”`（修正后）
- `”2026年6月13日 14日 国际新闻”`（再次精化）

**根因**

Claude 在一个 assistant turn 里会**同时生成多个工具调用**（并发 tool_use）。当模型同时生成 `get_current_time` 和 `web_search` 时，`web_search` 的 query 是在还没有时间结果的情况下构造的，只能依赖训练数据猜测当前日期，猜成了 2025年。

收到工具执行结果（拿到真实时间 2026年6月）后，模型发现 query 不对，又在下一轮发起了修正搜索，第三次是进一步时间精化。

执行层（`executeTools`）是**串行 for 循环**，工具并不是真的并行执行的——问题在于模型在**同一次推理**里就把两个工具调用都生成出来了，而非执行层的并发。

**错误的初步修复**

第一反应是在 prompt 里加”严禁重复搜索同一意图”——这是错误方向，因为那条规则会阻止合理的修正行为（比如第一次搜索确实用了错误年份，修正是必要的）。

**正确修复**

在 `WEB_SEARCH_CONTENT`（`lib/agent/prompt/segments.ts`）里明确约束工具调用顺序：

```
如果问题涉及时效性信息，必须先单独调用 get_current_time，
等到拿到时间结果后，再在下一步调用 web_search。
不得在同一步骤中同时调用 get_current_time 和 web_search。
```

同时把每轮 web_search 最大次数从 1 改为 2，允许”先查时间→再搜索”这种正常两步流程。

**关键洞察**

- 并发工具调用是 Claude 的默认行为，不是 bug，但在有**数据依赖**的场景下会产生错误（B 的 query 依赖 A 的结果，却和 A 同时生成）。
- 修复方向：通过 prompt 明确声明**调用顺序约束**，不是禁止重试。
- 通用原则：凡是工具 B 的输入依赖工具 A 的输出，就必须在 prompt 里写清楚”先调 A，再调 B”。
