# 知识库搜索开关

## 这个功能解决什么问题

在输入框「联网搜索」旁边加一个「知识库搜索」开关，默认开启。开启即代表"优先从个人知识库查找"——控制两件事：模型能否调用 `search_notes` 工具，以及后端是否自动把知识库检索结果注入 system prompt。

## 核心概念

### 开关不是一个"功能按钮"，而是一个"能力门控"

「知识库搜索」这个开关同时门控两条独立的检索通道，理解这点是写对这个功能的前提：

1. **工具通道（模型主动）**：模型在推理时判断"我需要查知识库"，主动调用 `search_notes` 工具。开关关掉时，这个工具根本不进 `tools` 列表，模型看不到也就无法调用。
2. **自动注入通道（后端被动）**：后端在请求进来时，用用户最后一句话当 query 主动检索知识库，把命中的资料拼进 system prompt。开关关掉时，跳过这次检索。

两条通道对应两处 gate，缺一条都会让开关"半失效"（比如只挡工具、不挡自动注入，用户关了开关还是会看到知识库内容）。

### 布尔标志的默认值约定：`!== false`

整条链路上这个标志的默认值都靠 `x !== false` 表达——只有显式传 `false` 才关闭，`undefined` / 缺字段都视为开启。这跟已有的 `enableWebSearch` 完全一致，好处是老客户端不传这个字段时行为不变（默认开），符合"默认选择"的需求。

## 工程实现

### 整体流程

开关状态从 UI 一路透传到后端，在后端分叉成两处 gate：

```
page.tsx (knowledgeSearchEnabled state, 默认 true)
  → ChatInput 按钮 toggle
  → activeSession.send(..., { knowledgeSearchEnabled })
  → chat-session.ts 拼进请求体 enableKnowledgeSearch
  → route.ts 读出 enableKnowledgeSearch
       ├─ gate 1: 过滤 tools，关掉时剔除 search_notes
       └─ gate 2: 关掉时跳过自动知识库检索注入
```

### 关键代码走读

**前端状态与透传**（`app/page.tsx`）
```ts
const [knowledgeSearchEnabled, setKnowledgeSearchEnabled] = useState(true); // 默认开
// handleSend 里：
await activeSession.send(text, rerender, { webSearchEnabled, knowledgeSearchEnabled, model });
```
状态放在 `page.tsx` 而不是 `ChatInput` 内部，因为 `handleSend` 也在 `page.tsx`，发请求时要读这个值——UI 组件只负责展示和回调。

**请求体字段**（`lib/chat/chat-session.ts`）
```ts
enableKnowledgeSearch: options.knowledgeSearchEnabled !== false,
```
和 `enableWebSearch` 并排，命名对齐。

**gate 1 — 工具过滤**（`app/api/chat/route.ts`）
```ts
const tools = toolRegistry
  .listForModel()
  .filter((tool) => enableWebSearch || tool.name !== "web_search")
  .filter((tool) => enableKnowledgeSearch || tool.name !== "search_notes");
```
链式 `.filter`，每条只在"关掉时"剔除对应工具，开着时全放行。

**gate 2 — 自动注入**（`app/api/chat/route.ts`）
```ts
if (enableKnowledgeSearch && shouldAutoSearchKnowledge(lastUser.content)) {
  // ... RAGRetriever 检索并拼进 knowledgeSystem
}
```

### 技术选型与决策

**为什么把 `shouldAutoSearchKnowledge` 从"关键词命中才检索"改成"非琐碎输入都检索"？**

改之前，自动注入只在用户问句里带"知识库/笔记/文档/资料/notion"关键词时才触发。但这个开关的语义是用户**显式声明**"优先从知识库查找"——如果还要求用户问句里出现关键词才检索，开关就形同虚设（用户问"我上周记的那个方案"不带关键词就查不到）。

所以决策是：开关本身承担"是否要查知识库"的意图，`shouldAutoSearchKnowledge` 退化成一个"排除明显不需要检索的输入"的过滤器（寒暄、实时信息如天气股价、纯文本改写、算术）。既尊重了用户开关的意图，又避免对"你好""1+1"这种输入做无谓检索。

**为什么不复用一个 `enableRetrieval` 同时管联网和知识库？** 两者是独立能力，用户可能只想查本地知识库不想联网（省钱/隐私），或反之。合并成一个开关会丢掉这个自由度。

## 踩坑记录

- **只挡一处 gate 是最容易犯的错**：如果只加了工具过滤而忘了 gate 2，用户关掉开关后模型确实不能主动查了，但后端仍会自动把知识库内容塞进 system prompt——用户会疑惑"我明明关了怎么还在用知识库"。两处必须同时改。
- `tsc --noEmit` 会报 `lib/agent/memory/session-store.ts` 的两个既有错误（`RedisSessionClient.on` 不存在），与本功能无关，是该文件已有的未提交改动，勿被误导。

## 延伸阅读
- [prompt-segmentation.md](../context/prompt-segmentation.md) — 知识库检索结果如何作为一个段注入 system prompt
- `lib/agent/tools/search-notes.ts` — `search_notes` 工具定义
- `lib/knowledge/retriever.ts` — RAG 检索实现
