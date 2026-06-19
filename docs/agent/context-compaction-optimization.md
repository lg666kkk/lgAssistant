# 上下文压缩优化方案

## 背景

当前 agent runtime 已经有一个基础的上下文压缩保护：

```txt
lib/agent/runtime/compaction.ts
```

它的作用是避免 `loopMessages` 在多轮工具调用后无限增长，把模型上下文撑爆。但目前实现更接近“字符串截断 + 简单拼接”，还不是语义层面的压缩。

当前压缩后的结构大致是：

```txt
第一条消息 + 较早消息的字符串摘要 + 最近 N 条消息
```

这作为兜底保护是有价值的，但它容易丢失：

- 用户最初目标
- 关键约束
- 已完成的代码改动
- 工具调用结果
- 当前未解决问题
- 后续应该继续做什么

Shannon 的上下文压缩实现提供了一些值得借鉴的思路，但不需要完整照搬 Temporal、Qdrant、多服务架构。对当前项目来说，更适合做一个轻量版 runtime 压缩系统。

## 目标

- 让长会话和多工具调用任务不轻易超过模型上下文窗口。
- 压缩后仍保留任务连续性。
- 避免反复压缩同一段历史。
- 在 trace 和 usage 中能看到压缩何时发生、压缩了多少。
- 保持实现轻量，符合当前 TypeScript runtime 架构。

## 非目标

- 不引入 Temporal 工作流编排。
- 第一阶段不依赖向量数据库。
- 不把所有会话自动写入长期记忆。
- 不在每次请求时都压缩。
- 不用压缩替代工具结果截断和 prompt budget 管理。

## 当前实现

当前入口：

```ts
compactLoopMessages(loopMessages, {
  maxTokens: 16_000,
  keepRecentMessages: 4,
});
```

当前行为：

- 使用 `JSON.stringify(value).length / 4` 粗略估算 token。
- 超过固定 `maxTokens` 后触发压缩。
- 保留第一条消息。
- 保留最后 `keepRecentMessages` 条消息。
- 中间消息用 `JSON.stringify(message.content).slice(0, 300)` 生成简短列表。

当前问题：

- 固定阈值 `16_000` 没有根据模型上下文窗口动态调整。
- 生成的 summary 不是语义摘要，只是缩略文本。
- 只保留第一条消息，不一定能保留完整的早期目标和约束。
- 没有区分 user、assistant、tool_use、tool_result。
- 没有 session 级别的压缩状态，容易重复压缩。
- trace 里没有结构化压缩记录，目前主要是 console log。

## Shannon 值得借鉴的点

### 1. 按模型窗口比例触发

Shannon 的核心触发思想是：

```txt
estimatedTokens >= modelWindow * triggerRatio
```

代码中常见默认值接近：

```txt
triggerRatio = 0.75
targetRatio = 0.375
```

也就是说，当上下文达到模型窗口约 75% 时触发压缩，压缩目标控制到模型窗口约 37.5%。

### 2. 使用滑动窗口结构

压缩后不是只保留最近消息，而是：

```txt
primers + compressed middle summary + recents
```

其中：

- `primers` 保留最早几条关键消息，通常包含用户目标和全局约束。
- `summary` 压缩中间历史。
- `recents` 保留最近几轮完整上下文，保证当前状态不丢。

### 3. 压缩需要限频

Shannon 会记录上次压缩状态，并限制：

```txt
距离上次压缩至少新增一定数量消息
距离上次压缩至少经过一定时间
```

这可以避免同一段历史在工具循环中被反复压缩。

### 4. 压缩要可观测

值得记录的指标：

```txt
originalTokens
compressedTokens
compressionRatio
tokensSaved
reason
```

这对排查“模型为什么忘了之前的事”非常有帮助。

### 5. 压缩是上下文塑形，不只是变短

好的压缩应该回答：

```txt
模型继续完成任务时，最需要知道什么？
```

而不是简单把旧消息截短。

## 推荐设计

### 压缩后的消息结构

建议压缩后给模型看到的结构是：

```txt
system prompt
早期关键消息 primers
结构化上下文摘要 summary
最近完整消息 recents
```

推荐默认值：

```txt
primerMessages: 3
recentMessages: 6
triggerRatio: 0.75
targetRatio: 0.375
```

早期消息负责保留任务源头，最近消息负责保留当前执行现场，中间摘要负责压缩历史过程。

### 结构化摘要格式

摘要不要写成一段泛泛的自然语言，建议固定结构：

```md
## 用户目标

## 重要约束

## 已完成工作

## 当前状态

## 重要文件和符号

## 工具结果和来源

## 未解决问题

## 下一步建议
```

这个格式比普通摘要更适合 agent 继续任务，因为它能快速恢复工作现场。

### 触发策略

建议用 policy 对象替代固定参数：

```ts
type ContextCompactionPolicy = {
  modelWindowTokens: number;
  triggerRatio: number;
  targetRatio: number;
  primerMessages: number;
  recentMessages: number;
  minNewMessagesSinceLastCompression: number;
};
```

触发判断：

```ts
const shouldCompact =
  estimatedTokens >= policy.modelWindowTokens * policy.triggerRatio;
```

`modelWindowTokens` 可以从 `lib/agent/models.ts` 中维护。

### 压缩状态

建议维护轻量的压缩状态：

```ts
type ContextCompactionState = {
  lastCompactedAt: number;
  lastCompactedMessageCount: number;
  totalCompactions: number;
  lastSummary?: string;
};
```

第一版可以先放在 runtime 内部。后续如果要跨请求保留，再写入 session metadata。

### Trace 集成

建议在 trace 中增加结构化压缩记录：

```ts
type CompactionTrace = {
  type: "context_compaction";
  startedAt: number;
  durationMs?: number;
  beforeTokens: number;
  afterTokens: number;
  modelWindowTokens: number;
  triggerRatio: number;
  targetRatio: number;
  primerMessages: number;
  recentMessages: number;
  reason: string;
  summaryChars: number;
};
```

这样如果压缩后模型答偏了，可以直接从 trace 看出压缩发生在哪一轮、压掉了多少内容。

## 分阶段实现

### Phase 1：改进确定性压缩

这一阶段不额外调用模型。

目标是把当前 `compaction.ts` 做得更稳：

- 用模型窗口比例替代固定 `16_000`。
- 保留 `primerMessages` 和 `recentMessages`。
- 按角色提取中间消息：
  - user：保留意图和约束
  - assistant：保留关键结论
  - tool_use：保留工具名和输入
  - tool_result：保留状态、错误、URL、摘要片段
- 返回结构化压缩结果。

建议 API：

```ts
export type CompactLoopMessagesOptions = {
  modelWindowTokens: number;
  triggerRatio: number;
  targetRatio: number;
  primerMessages: number;
  recentMessages: number;
};

export type CompactLoopMessagesResult = {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  summary?: string;
  reason?: string;
};
```

这个阶段的收益是：不用增加模型调用成本，就能让压缩结构更合理。

### Phase 2：增加语义压缩

当上下文超过触发线时，调用一个专门的压缩模型，把中间历史压成结构化摘要。

规则：

- 压缩调用不向用户流式输出。
- 优先使用便宜、快速的模型。
- 摘要长度受 `targetRatio` 控制。
- 压缩失败时回退到 Phase 1 的确定性压缩。
- 不把巨大的原始工具结果直接喂给压缩模型。

伪流程：

```txt
估算 loopMessages token
如果低于阈值：
  继续正常 agent loop

拆分为 primers / middle / recents
把 middle 压缩成结构化 summary
重新组装 messages
记录 compaction trace
继续 agent loop
```

### Phase 3：持久化压缩状态

将压缩状态写入 session：

```json
{
  "contextCompaction": {
    "lastCompactedAt": 1710000000,
    "lastCompactedMessageCount": 48,
    "totalCompactions": 3
  }
}
```

用途：

- 避免每轮重复压缩。
- 统计一个 session 压缩了多少次。
- 为 usage 页面展示压缩节省 token 做准备。

建议限频：

```txt
距离上次压缩至少新增 8 条消息
或者压缩后仍超过 hard cap 才允许再次压缩
```

### Phase 4：可选的长期记忆集成

等 runtime 压缩稳定后，再考虑把高质量摘要写入 semantic memory。

可做能力：

- 将压缩摘要作为 session summary memory 存储。
- 会话恢复时召回历史摘要。
- 按 session、时间、summary hash 去重。
- 只对长会话或用户开启记忆时写入。

这个阶段不应该阻塞上下文压缩本身。

## 压缩 Prompt 建议

压缩模型的 system prompt：

```txt
你负责压缩较早的对话上下文，供同一个 agent 继续完成当前任务。
请保留可执行状态、用户约束、关键决定、涉及文件、工具结果和未解决问题。
不要编造事实；不确定的信息请标注为不确定。
使用简洁 bullet，移除寒暄、重复表达和无关细节。
```

压缩模型的 user prompt：

```txt
请压缩下面这段中间历史对话。

必须返回 Markdown，并严格使用这些小节：
- 用户目标
- 重要约束
- 已完成工作
- 当前状态
- 重要文件和符号
- 工具结果和来源
- 未解决问题
- 下一步建议

目标长度：约 {targetTokens} tokens。

对话内容：
{middleMessages}
```

## 工具结果压缩策略

工具结果应该先塑形，再进入压缩器。

建议：

- `web_fetch`：保留 URL、title、status、method、snippet、相关正文片段。
- `web_search`：保留 query、前几个结果标题、URL、摘要。
- `search_notes`：保留 page title、page URL、similarity、excerpt。
- 失败工具：保留工具名、输入、错误信息。

避免把完整网页正文、大段 JSON、过长 tool_result 直接喂给压缩模型。

## 当前项目推荐默认值

```ts
const DEFAULT_COMPACTION_POLICY = {
  triggerRatio: 0.75,
  targetRatio: 0.375,
  primerMessages: 3,
  recentMessages: 6,
  minNewMessagesSinceLastCompression: 8,
};
```

如果模型上下文按 64k 估算：

```txt
触发线：约 48k estimated tokens
目标线：约 24k estimated tokens
```

在当前开发阶段，建议保留一个更低的硬保护：

```txt
soft trigger: modelWindow * 0.75
hard emergency trigger: 24k-32k estimated tokens
```

这样即使 token 估算不准，也不容易直接撞上下文上限。

## 验收标准

- 长工具调用会话不会突然撞上下文预算。
- 压缩后 agent 仍能记住用户原始目标。
- 压缩后 agent 仍能记住最近工具结果和下一步。
- trace 能展示压缩发生时间、压缩前后 token、节省比例。
- 压缩模型调用失败不会中断 agent loop。
- 同一段历史不会在连续工具循环中被反复压缩。

## 建议下一步

优先做 Phase 1：

1. 用 policy 对象替代固定 `maxTokens: 16_000`。
2. 保留早期 `primerMessages` 和最近 `recentMessages`。
3. 返回结构化 compaction metadata。
4. 把压缩详情写入 trace。

Phase 1 稳定后，再用 feature flag 开启 Phase 2 的语义压缩。
