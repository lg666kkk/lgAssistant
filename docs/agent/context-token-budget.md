# 上下文与 Token 预算管理

> 对应 [agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md) 能力 1（⭐⭐⭐ 地基）。

## 这个功能解决什么问题

Agent Loop 每轮把 `tool_use` / `tool_result` 不断追加进 `loopMessages`，上下文只增不减。一旦工具返回长文档（如 RAG）或轮数变多，会同时引发三个问题：**爆 context 直接报错、成本失控、模型被早期无关内容淹没导致决策变差**。这个功能给 loop 加上三层防护，让它在长任务下不爆、可度量。

## 核心概念

- **模型是无状态的**：每轮能力上限完全由塞进 context window 的内容决定，context 是唯一的"工作记忆"，必须当成有限资源管理。
- **三层策略**（这是面试高频答法）：
  1. **硬上限 + Token 预算** — 设一个 max token，超了就停并兜底总结；
  2. **工具结果截断** — 单个大结果截断，避免它独吞 context；
  3. **滚动压缩** — 早期轮次摘要化，只保留最近 K 轮原文。
- **本地 token 预估**：请求前用 `gpt-tokenizer` 做上下文预算和截断；请求后的计费与展示仍以模型返回的真实 `usage` 为准。

## 工程实现

### 整体流程

`runAgentLoop` 每轮调模型**之前**：

```
for 每一轮 (上限 maxToolIterations):
  1. 压缩：若 loopMessages 估算超阈值 → 保留首条 + 最近 4 条，中间摘要化
  2. 预算检查：估算当前上下文 token，问 TokenBudget 还塞得下吗？
       塞不下 → 兜底（提示"预算用尽，基于已有信息回答"）并 return
  3. spend(本轮 token)，累加 metrics
  4. callModel → 无 tool_use 则结束；有则执行工具
  5. 工具结果在塞回 messages 前先 truncateToolContent 截断
```

### 关键代码走读

**[budget.ts](../../lib/agent/runtime/budget.ts) — `TokenBudget.spend`**
```ts
spend(tokens: number) {
  this.spent += Math.max(0, tokens);  // 负数当 0，防止把预算"倒加"回去
}
```

**[budget.ts](../../lib/agent/runtime/budget.ts) — `truncateToolContent`**
截断后仍返回 `truncated` / `originalChars` 元数据，这样前端和 trace 能知道"这里发生过截断"，而不是悄悄丢内容。

**[runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop`**
```ts
const compacted = compactLoopMessages(loopMessages, { maxTokens: 16_000, keepRecentMessages: 4 });
loopMessages = compacted.messages;
const estimatedContextTokens = estimateTokens(JSON.stringify(loopMessages));
if (!tokenBudget.canAfford(estimatedContextTokens)) { /* 兜底总结并 return */ }
tokenBudget.spend(estimatedContextTokens);
```
顺序很关键：**先压缩、再估算、再问预算**。压缩在前，预算检查看到的才是压缩后的真实大小。

**[compaction.ts](../../lib/agent/runtime/compaction.ts) — 保留结构**
```ts
const firstMessage = messages[0];                              // 首条（含 system/RAG 注入）必须留
const recentMessages = messages.slice(-keepRecentMessages);    // 最近 K 条原文留
const olderMessages = messages.slice(1, -keepRecentMessages);  // 中间的摘要化
```

### 技术选型与决策

- **本地 tokenizer vs 真实 usage**：本地 tokenizer 只用于请求前决策，比如是否压缩、是否截断工具结果；真实费用和 usage 页面仍使用 provider 返回的 `usage`。这样能同时保证上下文控制更准、账单统计不失真。
- **截断 vs 压缩为什么都要**：截断针对"单个大结果"，压缩针对"轮数累积"，两个膨胀来源不同，缺一层都可能爆。
- **当前运行参数**：DeepSeek V4 的工作窗口上限为 80_000 tokens，常规压缩在 48_000 tokens 触发、目标压到约 24_000 tokens；单次 Agent Run 的累计预算为 128_000 tokens。参数当前仍直接写在 runtime 中，后续可再收口到配置层。

## 踩坑记录

- **顺序错会失效**：如果先估算预算、后压缩，预算看到的是压缩前的膨胀大小，会误判"超预算"提前兜底。必须压缩在前。
- **重复工具调用 ≠ 用户输入重复**：loop 里的 `seenToolCalls` 防的是模型自己卡在循环里反复调同一工具，不是防用户问重复问题——这两个概念早期容易混。
- **RAG 召回为 0 的策略演进**：最初把 `similarityThreshold` 从 0.7 降到 0.5，并使用 threshold=0 兜底；该做法会引入误召回，现已改为受控二级召回：0.5 无结果时最多降到 0.4、最多保留 3 条，并要求综合证据分不低于 0.28，否则返回无结果。

## 延伸阅读

- Anthropic: Effective context engineering / context management
- 下一步：[agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md) 能力 3（可观测性/Eval）——本次已在 [route.ts](../../app/api/chat/route.ts) 打了 `[AgentLoopMetrics]` 日志，正是 trace 的引子。
