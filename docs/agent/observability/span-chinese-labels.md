# Langfuse span 的中文作用标识（spanLabel）

> 相关：[observability-trace-eval.md](./observability-trace-eval.md)（trace 上报的整体链路）、
> [trace-visualization.md](./trace-visualization.md)（本地 trace 的 UI 展示）。

## 这个功能解决什么问题

Langfuse 的 trace 树里，每个 span 的名字是英文技术标识：

```
agent-chat
 ├─ rag.route
 ├─ memory.explicit_forget
 ├─ memory.recall
 ├─ context.compaction
 ├─ agent-loop-initial:ai.streamText
 ├─ agent-loop-after-tools:search_notes:ai.streamText
 ├─ memory.consolidate
 ├─ rag.retrieve
 └─ rag.evidence_validation
```

名字对写代码的人是清楚的，但对着面板排查、给别人讲这条链路、或者过几周自己回看时，
「`rag.route` 到底是决定走哪条检索，还是已经在检索了」这种问题每次都要翻代码确认。

做法：给**每一个上报**的 `metadata` 补一个固定字段 `spanLabel`，值是中文的作用说明，
在 Langfuse 详情页的 Metadata 区块直接可读。

## 核心概念

### 1. 单一映射表，不在调用点写死中文

中文说明如果散在各个 `startObservation` 调用点，很快会出现同一个环节两种叫法。
所以统一收敛到 [lib/agent/observability/span-labels.ts](../../../lib/agent/observability/span-labels.ts)：

```ts
export const SPAN_LABELS: Record<string, string> = {
  "rag.route": "检索路由决策（判断走知识库还是联网）",
  "memory.recall": "记忆召回（把相关长期记忆注入 system）",
  "context.compaction": "上下文压缩（超预算时裁剪/摘要历史）",
  // …
};
```

新增 span 时只改这一张表，忘了改则显示兜底文案 `未登记环节`——
**显式说「没登记」比留空字段好**，留空会被误读成"这次没上报"。

### 2. 动态 span 名按 ":" 逐段回退

Agent loop 的 functionId 是拼出来的，带上了本轮触发的工具名：

```
agent-loop-after-tools:search_notes+read_tool_artifact
plan-and-execute-planner:repair
```

映射表不可能穷举工具组合。`resolveSpanLabel` 从最长前缀往回退：

```ts
const segments = trimmed.split(":");
for (let end = segments.length; end > 0; end--) {
  const candidate = segments.slice(0, end).join(":");
  if (SPAN_LABELS[candidate]) return SPAN_LABELS[candidate];
}
return UNKNOWN_SPAN_LABEL;
```

「最长优先」是关键：`plan-and-execute-planner:repair` 有自己的条目（JSON 修复重试），
必须命中它而不是回退到父条目 `plan-and-execute-planner`（任务规划）。
而 `plan-and-execute-planner:ai-sdk` 没登记，就正确地回退到父条目。

### 3. 两种注入方式

| 上报类型 | 注入点 | 方式 |
| --- | --- | --- |
| 手写 span（`startObservation` / `update` / `propagateAttributes`） | 调用点 | `metadata: withSpanLabel("memory.recall", { requestId })` |
| 模型调用（AI SDK 自动生成的 `ai.streamText` / `ai.generateText`） | `compactMetadata` | 由 `functionId` 反查，调用方零改动 |

模型调用这条走集中注入，是因为 span 名不是我们起的——AI SDK 用 `experimental_telemetry.functionId`
作为 span 名前缀。既然 functionId 一定会传给 `compactMetadata`，就在那里统一补：

```ts
function compactMetadata(functionId: string, metadata?: ModelTelemetryMetadata) {
  const compacted = { [SPAN_LABEL_METADATA_KEY]: resolveSpanLabel(functionId) };
  // …过滤 undefined/null 后合入 metadata
}
```

这样以后任何新的模型调用点，只要 functionId 登记进表就自动带标识，不会漏。

## 代码走读

改动点（都只加不改语义）：

| 文件 | 内容 |
| --- | --- |
| [lib/agent/observability/span-labels.ts](../../../lib/agent/observability/span-labels.ts) | 映射表 + `resolveSpanLabel` + `withSpanLabel` |
| [lib/agent/runtime/model-provider.ts](../../../lib/agent/runtime/model-provider.ts) | `compactMetadata` 增加 functionId 入参，集中注入 |
| [app/api/chat/route.ts](../../../app/api/chat/route.ts) | `agent-chat` / `rag.*` / `memory.*` 六个 span |
| [lib/agent/runtime/index.ts](../../../lib/agent/runtime/index.ts) | `context.compaction` |
| [lib/agent/runtime/plan-execution.ts](../../../lib/agent/runtime/plan-execution.ts) | `plan-and-execute-planner` |
| [app/api/knowledge/sync/route.ts](../../../app/api/knowledge/sync/route.ts)、[wiki/compile/route.ts](../../../app/api/knowledge/wiki/compile/route.ts) | 两条知识链路的根 trace |

## 决策记录

**为什么不直接把 span 名改成中文？**
span 名是聚合维度——Langfuse 按 name 做延迟/成本统计，也用于告警规则和 API 过滤。
改名会切断历史数据的连续性，中英混排在查询里也难写。名字保持稳定英文，语义放 metadata。

**为什么 metadata key 用英文 `spanLabel`，值才是中文？**
key 参与程序化过滤（`metadata.spanLabel = "..."`），中文 key 在 URL 和查询里要转义，得不偿失。

**为什么不给本地 AgentTrace 的 step 也加？**
本地 trace 的 step 有 `type` 判别字段（`model` / `tool` / `retrieval` / `answer_validation`…），
详情页已经按 type 渲染了中文标题，语义没有丢，再加一层是冗余。

## 踩坑记录

- `propagateAttributes` 的 `metadata` 类型是 `Record<string, string>`，
  `withSpanLabel` 一开始返回 `Record<string, unknown>` 直接类型不兼容。
  改成泛型 `T & Record<"spanLabel", string>` 保留入参的具体类型才通过 `tsc`。
- `compactMetadata` 原来在 `metadata` 为空时返回 `undefined`，等于该 span 完全没有 metadata。
  加了 spanLabel 后返回值改成必定有对象——否则「每个上报都有中文标识」这条就不成立。
- AI SDK 自动生成的子 span（`ai.streamText.doStream`）不继承父 span 的 metadata，
  中文标识只出现在父 `ai.streamText` 上。这是 SDK 行为，看子 span 时往上一层看。

## 验证

```bash
npx vitest run lib/agent/observability/span-labels.test.ts
```

覆盖：精确命中、动态后缀回退、最长优先、未登记兜底、metadata 合并、调用方显式覆盖不被改写。
