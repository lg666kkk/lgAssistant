# Prompt 段化注入（Prompt Pipe 最小内核）

> 承接 [trace-visualization.md](./trace-visualization.md)（可视化）。  
> 对应 ROADMAP M2.4「Prompt Pipe 组装管道」的核心部分。

## 这个功能解决什么问题

之前 system prompt 在 `route.ts` 里裸字符串拼接：

```ts
const systemPrompt = [memorySystem, enableWebSearch ? "用户已开启联网搜索…" : ""].filter(Boolean).join("\n\n");
```

三个问题：
1. **trace 看不出结构** — 详情页只能看到一块混合文本，无法区分「这段是记忆、这段是策略」；
2. **没有身份段** — 模型没有统一的角色约束，行为全靠默认；
3. **组装逻辑散在路由里** — 加新来源（RAG 片段、当前时间）必须改路由，不可测。

这次做「Prompt Pipe 最小内核」：把 system 组装从字符串拼接升级为**段（segment）数组构造 + 渲染**，段数组同时写进 trace，详情页按段分块展示。

## 核心概念

- **段（PromptSegment）**：一个有 `kind`（类型）/ `title`（给人看的名字）/ `content`（正文）的数据结构。每个注入来源对应一段。
- **`buildSegments` → `renderSegments` 两步走**：先把输入数据构造成段数组（可测、可检查结构），再渲染成模型消费的字符串。字符串本身格式与之前的裸拼一致（段间 `\n\n`），下游 `callModel` 零改动。
- **段 vs 字符串的本质区别**：字符串传进 trace 只是「一坨文本」；段数组传进 trace 带有语义——详情页知道「第一块是身份，第二块是记忆，第三块是联网策略」，可以分块配色展示。
- **最小内核不做优先级/预算**：段目前按顺序（身份→记忆→策略）直接渲染，不做「预算不足时裁剪低优先级段」。那是完整 Prompt Pipe 的后续工作。

## 工程实现

### 整体流程

```
route.ts
  buildSegments({ memory, webSearchEnabled })   → PromptSegment[]
  renderSegments(segments)                       → system: string
  runAgentLoop(…, system, …, segments)
    ↓ 每轮 modelStep
    systemSegments: segments  （写进 trace）
    systemPrompt: truncate(system)               （截断后的兜底字符串）
  saveTrace → agent_traces（JSONB，零改表）

traces/[id]/page.tsx
  step.systemSegments 有 → 按段分块展示（配色标签 + 正文）
  step.systemSegments 无 → 回退 step.systemPrompt 整段（旧 trace 兼容）
  两者都无 → 不渲染（更早的 trace）
```

### 关键代码走读

**[lib/agent/prompt/segments.ts](../../lib/agent/prompt/segments.ts)**  
三个段构造函数（纯函数，输入→段数组）：
- `identity`（priority 最高）：固定身份文本，默认启用，`includeIdentity: false` 可关闭
- `memory`：`recallForPrompt` 的返回直接作为 content，空串跳过不产生段
- `web-search-policy`：`enableWebSearch=true` 时产生

`renderSegments` 只做 `.map(s => s.content).join("\n\n")`——渲染结果与改造前的裸拼一致，模型侧无感知。

**[runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop` 签名**  
新增末尾可选参数 `systemSegments?`，写进每轮 `modelStep.systemSegments`。整个 loop 的 system 不变，但逐 step 记录，单看任意 step 即可知道当轮注入了什么段。

**[app/traces/[id]/page.tsx](../../app/traces/[id]/page.tsx) `SystemContext` 组件**  
段类型 → 配色 tag（identity=紫/memory=绿/web-search-policy=蓝），每段独立展开。`segments.length === 0 && !step.systemPrompt` 时返回 `null`，旧 trace 不会渲染空块。

### 技术选型与决策

- **段化 vs 前端猜解析**：前端按 `\n\n` 切再靠关键词猜哪段是什么，文案一变就失效；后端记段结构稳定不受文案影响——哪怕身份段改成英文，`kind: "identity"` 不变，展示逻辑不用动。
- **为什么先不做优先级/预算**：这次目标是「trace 能按段展示」，不是「context 不爆」（那由写入侧三层已经保护）。优先级/预算是 Prompt Pipe 的完整版，放后续迭代，避免过早堆抽象。
- **`systemPrompt` 字段保留原因**：是截断后的整段文本兜底，旧 trace 只有这个字段，`SystemContext` 把它作为回退展示路径。两个字段并存、不冗余——`systemSegments` 给新 trace，`systemPrompt` 给旧 trace 和调试。
- **身份段是新增行为**：之前模型完全没有角色约束，现在统一注入一段简短身份（个人知识助手、可调工具、不杜撰来源）。这是功能性改动，会影响每条回答的基础行为。

## 踩坑记录

- **zsh 展开 `?` 导致 curl 404**：`curl http://…/api/traces?limit=1` 在 zsh 里 `?` 被当作 glob 展开，结果找不到文件报 404。加引号 `"http://…/api/traces?limit=1"` 解决。
- **dev 进程陈旧**：改了代码、跑了 build，但 dev 进程还是旧的，API route 返回旧版 HTML 而非 JSON。遇到 API 返回 HTML 时，第一反应查是否需要重启 dev。
- **末尾可选参数顺序**：`runAgentLoop` 已有很多位置参数，新增 `systemSegments` 放最后，eval/runner.ts 等调用方不传也能编译通过，不需要改所有调用点。

## 延伸阅读

- 本次只做段化内核；后续完整 Prompt Pipe：加 `priority` 字段 + `TokenBudget` 预算裁剪（复用 [context-token-budget.md](./context-token-budget.md) 的 `estimateTokensFromText`），超预算时丢弃低优先级段并记进 `droppedSegmentIds`。
- 上一篇（可视化）：[trace-visualization.md](./trace-visualization.md)
