# 可观测性可视化：Trace UI

> 承接 [observability-trace-eval.md](./observability-trace-eval.md)（能力 3）。上一篇把 trace 记下来并落库，这篇把它**搬到界面上看得见**。

## 这个功能解决什么问题

trace 之前只有两种存在形式：终端里一闪而过的 `formatTraceTree` 缩进树，和 Supabase `agent_traces` 表里的 JSONB 行。前者看完即逝、不能回溯；后者要手写 SQL 才能读。结果是「数据齐全，但没人看」。

更尖锐的痛点来自上下文工程：当你调了压缩阈值、改了记忆召回、加了一段 system 策略，**怎么判断它变好还是变差？** 凭感觉不行。这个功能给出一个可回溯的界面——一次请求逐步发生了什么、每轮喂给模型的上下文长啥样——让「上下文工程做完不知道好不好」变成「点开 trace 一步步看」。

## 核心概念

- **可观测性 ≠ 评估**：评估给 pass/fail 或分数，可观测性给「看清过程」。先能看见，才谈得上判断好坏。本次只做「看见」，不做打分。
- **列表薄、详情厚**：列表页只 `select` 概览字段（停止原因、耗时、调用次数），不拉 `steps`/`metrics` 这些 JSONB 大字段；详情页才按 id 拉完整明细。避免列表页一次性把所有 trace 的全部 step 拖下来。
- **上下文可观测性的核心是「记录注入了什么」**：trace 原本记了模型吐什么、调什么工具，却没记**这轮喂进去的 system prompt**。补上 `ModelTraceStep.systemPrompt` 后，详情页才能回答「这次到底注入了哪些上下文」——这正是上下文工程能被观察的关键一环。
- **JSONB 整存的好处**：`steps` 是 JSONB，给 step 加字段（`systemPrompt`）**不用改表结构**，新字段自动被容纳，旧行只是没有该字段。

## 工程实现

### 整体流程

```
写入：runAgentLoop 每轮把 system 截断后写进 modelStep.systemPrompt
     → saveTrace 落库 agent_traces（JSONB，无需改表）
读取：/api/traces        列表（概览字段，倒序，limit）
     /api/traces/[id]    单条完整明细（含 steps）
展示：/traces            列表页（停止原因配色 + 概览指标）
     /traces/[id]        逐步时间线（model 步 / tool 步 + 折叠看长文本）
```

### 关键代码走读

**[trace.ts](../../../lib/agent/runtime/trace.ts) — 给 model step 加 systemPrompt**
`ModelTraceStep` 新增 `systemPrompt?` / `systemPromptTruncated?` / `systemPromptOriginalChars?`，全部可选——旧 trace 没有这些字段，类型上也兼容。复用已有的 `summarizeText`（即 `truncateToolContent(text, 500)`）截断，不引新的截断逻辑。

**[index.ts](../../../lib/agent/runtime/index.ts) `runAgentLoop`**
```ts
const systemSummary = system ? summarizeText(system) : undefined;
// modelStep 里：
systemPrompt: systemSummary?.content,
```
整个 loop 的 `system` 不变，但仍逐 step 记录——这样单看任意一步就知道当时注入的上下文，不必回溯到请求开头。

**[api/traces/route.ts](../../../app/api/traces/route.ts) vs [[id]/route.ts](../../../app/api/traces/[id]/route.ts)**
列表 `.select("id,request_id,...,metrics,created_at")` 显式列字段、跳过 `steps`；详情 `.select("*").eq("id",id).maybeSingle()`。`maybeSingle` 在查不到时返回 `null` 而非抛错，方便返回 404。

**[traces/[id]/page.tsx](../../../app/traces/[id]/page.tsx) — Collapsible 优雅降级**
`Collapsible` 在 `body` 为空串时 `return null`。所以旧 trace（没有 `systemPrompt`）不会渲染出空的「查看注入的 system prompt」开关，新 trace 才显示。无需对新旧数据分支判断，空即隐藏。

### 技术选型与决策

- **两个 route 而非一个带 query 分支**：`/api/traces`（列表）和 `/api/traces/[id]`（详情）分开，符合 Next.js App Router 文件约定，比单 route 内 `if (id)` 分流更清晰。
- **列表页配色映射 stopReason**：`completed` 绿、`max_iterations`/`repeated_tool_call` 琥珀（循环保护触发）、`token_budget_exceeded` 红（爆预算）。让异常退出在列表一眼可见，不用点进去。
- **不做实时面板（先做可回溯列表）**：实时面板刷新即丢，可回溯列表是根。实时留作后续增量。
- **system prompt 也走 500 字符截断**：和 trace 其它文本一致。注入的上下文可能很长，详情页只需看清结构，不需要逐字；真要全文可去 `agent_traces` 表查原始（不过当前落库的也是截断后的——若日后要全文存原始，需在落库前另存未截断副本，属已知取舍）。

## 踩坑记录

- **端口占位假象**：`npm run dev` 发现 3000 被占用自动切到 3001，curl 仍打 3000 时打到的是另一个进程，返回空、像是「接口没生效」。验证前先看 dev log 实际监听端口。
- **旧 trace 没有新字段不是 bug**：本次加的 `systemPrompt` 只对改动后产生的 trace 生效，历史行查出来该字段为 `undefined`。靠 `Collapsible` 空即隐藏来兼容，不要去给旧数据补字段。
- **sessionId 必须是 UUID**：手测时随手传 `"trace-test-1"` 触发 `invalid input syntax for type uuid`——`session_id` 有外键和 UUID 约束。这是测试输入问题，不是代码问题，但提醒：trace 落库的 `session_id` 依赖上游传合法 UUID。
- **API key 失效会卡在模型层**：验证时遇到 `401 Invalid token`，模型调不通则产生不了新 trace。可观测性链路本身正常（历史 trace 的列表/详情接口都连通），但端到端「发消息→看新 trace」依赖有效的 `DEEPSEEK_API_KEY`/`ANTHROPIC_API_KEY`。

## 延伸阅读

- 上一篇：[observability-trace-eval.md](./observability-trace-eval.md)（trace 数据结构 + Eval 离线回归）
- 下一步可做：把「注入了哪些上下文段」结构化（配合 Prompt Pipe），详情页按段展示而非整段 system 文本；或加实时面板在对话侧边看当轮过程。
