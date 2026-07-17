# 上下文管理问题清单与改进方案（2026-07 代码审查）

> 审查范围：`lib/agent/runtime/compaction.ts`、`budget.ts`、`tokenizer.ts`、`index.ts`（工具结果整形/压缩调用/预算守卫）、`lib/agent/prompt/*`、`app/api/chat/route.ts`（历史补齐/记忆注入）。
> 结论：四层机制（prompt 组装 / 工具结果整形 / 循环内压缩 / 硬预算）架构正确，但**层与层的交互存在两个真实 bug 和一个缓存失效问题**。改进主线不是加第四层，而是给层间交互补测试和修正。

---

## 1. 现状：四层机制

| 层 | 机制 | 位置 |
|---|---|---|
| ① Prompt 组装 | 段化（priority + 段级 tokenBudget）→ 贪心裁剪（总预算 4200）→ 渲染 | `prompt/pipe.ts`、`prompt/budget.ts:27` |
| ② 工具结果整形 | 每工具定制 shaper → 硬截 1200 token → 大结果落 artifact 只留摘要+id，可分页回读 | `runtime/index.ts:338`、`:404` |
| ③ 循环内压缩 | 超 60%×min(窗口,80k) 且新增 ≥8 条 → 保头 3 尾 6，中段 LLM 摘要（flash）+ 确定性回退 | `runtime/compaction.ts:170`、`runtime/index.ts:984` |
| ④ 硬预算 | TokenBudget 128k 累计（优先真实 usage 记账），不够先强制压缩再硬停 | `runtime/index.ts:1051`、`:1224` |

不用动的部分：三层防爆分工、artifact 分页回读、压缩限频、压缩 trace 记录、真实 usage 记账。

---

## 2. 问题清单

### 🔴 P0-A：压缩切分破坏 tool_use / tool_result 配对（隐藏 bug）

- **位置**：`compaction.ts:170` `splitMessagesForCompaction` 纯按条数切（头 3 / 尾 6）。
- **机理**：loop 消息严格配对（`assistant(tool_use)` → `user(tool_result)`）。两种破坏方式：
  1. 尾窗第一条是 `tool_result`、其 `tool_use` 被压进摘要 → 孤儿 tool_result。`model-provider.ts:81` 转成 `toolName:"unknown"` 的 `role:"tool"` 消息，OpenAI 兼容 API 要求 tool 消息跟在带匹配 tool_call_ids 的 assistant 后面，**会 400 或行为未定义**；
  2. 头窗以悬空 `tool_use` 结尾、后接摘要文本 → 非法 tool_calls。
- **触发条件**：长对话压缩时，取决于消息奇偶性，概率约一半——典型的难排查隐藏 bug。
- **修法**：切分后做边界修正——recent 起点是 tool_result 则向前扩一条收进 tool_use；primer 终点是悬空 tool_use 则缩一条。补单测：构造奇偶两种序列，断言压缩产物中每个 tool_result 前有匹配 tool_use。

### 🔴 P0-B：二次压缩把上一轮摘要砍到 360 字符（复利信息丢失）

- **位置**：摘要产物是普通 user 消息（`compaction.ts:216`）；下次压缩落在中段，走 `summarizeMessage`（`compaction.ts:143`）普通文本分支 `truncateText(text, 360)`。
- **机理**：第一次压缩产出的 ~2000 token 结构化摘要，第二次压缩时先被物理截到 360 字符才交给压缩模型。长任务每压一次，早期信息复利式蒸发。
- **修法**：摘要消息打可识别标记（固定前缀或 metadata），下次压缩识别后**全文放入 digest 的「先前摘要」小节**（跳过截断），压缩 prompt 显式合并新旧摘要——变成单一演进摘要，而非摘要的摘要。

### 🟠 P1-A：system 渲染顺序动态在前，prefix cache 全失效

- **位置**：`prompt/budget.ts:20` `rankSegments` 按 priority 降序，渲染顺序 = 排序顺序；priority 最高的是每轮都变的 `task-context`「当前问题」段（110）。
- **机理**：system 第一段就是动态内容，且 system 在请求最前 → DeepSeek 前缀缓存每个请求从第 1 个 token 就 miss。cache hit 0.02 元/M vs miss 1 元/M，50 倍差价全放弃。已记 `cacheHitTokens` 指标，可直接量化验证。
- **修法**：排序与渲染分离——rank 只用于预算裁剪；渲染顺序按稳定性：identity → 静态 policy → memory → knowledge → task-context 最后。改完对 `cacheHitRate` 验证。

### 🟠 P1-B：压缩 digest 预截断丢关键信息（含 artifact_id）

- **位置**：`compaction.ts:133` digest 中工具结果截 260 字符、普通消息 360 字符。
- **机理**：LLM 在已严重有损的输入上做摘要。最实际伤害：`artifact_id: xxx` 回读凭证藏在工具结果文本里，截断后丢失 → 压缩后模型永远无法回读原文，**第三层防爆废掉了第二层防爆**。
- **修法**：截断前用正则抽出 `artifact_id`、工具名、URL 等结构化凭证单独保留进 digest。

### 🟡 P2（中低优先级）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| C | `omittedSegments` 没进 trace——「哪段被丢、为什么」已算出但未记录（C5 收尾差这一步） | `pipe.ts:34` 返回值被 route 丢弃 | 写进 ModelTraceStep，一行改动级别 |
| D | 头尾按条数不按 token：尾 6 条含大工具结果时压缩后仍超标 | `compaction.ts:45` 固定 primer 3/recent 6 | recent 从尾部向前按预算累加（如目标的 40%），与 P0-A 边界修正合并实现 |
| E | `truncatePromptContent` 用 chars/4 截断，与项目内 `truncateTextByTokens` 两套口径 | `prompt/budget.ts:14` | 换用 tokenizer 版 |
| F | 会话历史按条数补（15 条）不按 token；前端传多条时绕过服务端控制 | `route.ts:328` | 按 token 预算补齐；多条输入同样裁剪 |
| G | 记忆召回 query 只用最后一条 user 消息，指代型追问召回不到 | `route.ts:342` | 拼最近 1-2 轮做指代消解后再召回（复用 RAG rewriteQuery 思路） |

---

## 3. 实施批次

| 批次 | 内容 | 成本 | 收益 |
|---|---|---|---|
| 第一批（修 bug） | P0-A 配对安全切分 + 单测；P0-B 摘要保真传递；P1-B digest 凭证保护 | S~M | 消除隐藏 400、止住长任务信息蒸发、保住 artifact 回读链 |
| 第二批（缓存与可观测） | P1-A 排序渲染分离（用 cacheHitRate 验证）；P2-C omittedSegments 进 trace；P2-E 统一截断口径 | S | 缓存成本直降、C5 收尾 |
| 第三批（结构升级） | P2-D token 感知头尾；ContextPlan 统一装配（路线图 C5 完整版）；P2-F/G | M~L | 上下文工程闭环 |

## 4. 面试视角

- 「三层防爆各自都对，但层间交互没被测试：压缩破坏模型协议（层3伤API）、压缩吞 artifact_id（层3废层2）、动态段排最前（层1废缓存）。系统级 bug 往往在层间。」
- 「我用自己记的 cacheHitTokens 指标发现 prefix cache 全失效，根因是把预算优先级当成了渲染顺序——两个概念要分离。」
- 「压缩产物再次被压缩时要有特殊通道，否则是摘要的摘要的摘要，信息复利丢失。」
