# 分层记忆系统（能力 2）

> 对应 [agent-core-capabilities-roadmap.md](./agent-core-capabilities-roadmap.md) 能力 2。
> 本笔记随实现逐课追加，当前进度：**第 1~5 课（架构设计 / 长期记忆 / 语义记忆 / 记忆流动 / 会话记忆）均已完成。记忆系统完整。**

## 这个功能解决什么问题

Agent 默认只有「上下文窗口」这一种记忆，对话一结束就全忘。分层记忆给 agent 四种保留时长不同的记忆，并给每层匹配最合适的存储：

| 层级 | 时长 | 内容 | 存储 |
|---|---|---|---|
| 工作记忆 | 秒-分钟 | 正在处理的内容 | 上下文窗口（不落库） |
| 会话记忆 | 分钟-小时 | 本次对话历史 | Redis |
| 长期记忆 | 天-月 | 用户偏好、成功模式 | PostgreSQL |
| 语义记忆 | 永久 | 历史问答、知识库 | pgvector（可与长期记忆共用一个 Postgres） |

核心难点不是「选哪个数据库」，而是**四种天差地别的存储，主循环如何统一使用** —— 靠一层抽象接口解耦。

## 核心概念

- **按「读写模式」而非「记忆类型名」设计接口**：决定存储的是「怎么访问」（按 key 取 / 按相似度召回），不是「它叫什么类型」。所以接口方法是 `get/set/recall`，不是 `getEpisodic/getSemantic`。
- **工作记忆不进 MemoryStore 接口**：它就是 `messages` 数组本身，由 budget/compaction 管理。把它塞进存储接口是设计错误。
- **接口隔离原则（ISP）**：`recall`（按相似度召回）只有语义层有意义，会话/长期层没有 embedding。所以不把 `recall` 放进主接口逼所有层实现，而是拆进子接口 `SemanticMemoryStore extends MemoryStore`，只有语义层实现。
- **业务 key vs db 自增 id**：`set(key)` 写入时自己指定的业务键（如 `user:123:pref:lang`）；`MemoryRecord.id` 是 db 自动生成的主键。增删查用 **key** 配对，否则 set 完拿不回来。

## 工程实现

### 第 1 课：统一抽象（types.ts）

```
MemoryStore (主接口)               ← 主循环只依赖这个，四层皆实现
  get / set / forget / list        ← 四层都天然支持的 key 操作
        ▲
        │ extends
SemanticMemoryStore                ← 仅语义层实现
  + recall(query, k)               ← 额外的「按相似度召回」能力
```

实现位置：[types.ts](../../lib/agent/memory/types.ts)。本课只写类型/接口，零实现。

### 技术选型与决策

- **统一 `MemoryRecord` 形状**：无论哪层，一条记忆同一结构（`id/layer/content/metadata/score?/createdAt`），上层不关心来源。延续项目里 `SearchResult`/`DocumentChunk` 的思路。
- **`recall` 拆子接口而非放主接口**：避免 SessionStore 实现一个没有向量、只能返回假数据的 `recall`（ISP）。拆对后 `recall` 的 `layer` 参数也自然消失（SemanticStore 天然只管语义层）。
- **`layer` 复用 `MemoryLayer` 别名**：DRY，以后改层只改一处。

### 第 2 课：长期记忆实现（PostgreSQL）

打通「写入 → 读回」完整闭环，第一个能真跑、有测试护航的实现。

- 表结构：[memories-schema.sql](../../docs/schemas/memories-schema.sql)（表名 `agent_memories`）
- 实现类：[longterm-store.ts](../../lib/agent/memory/longterm-store.ts)（`LongTermStore implements MemoryStore`）
- 闭环测试：[longterm-store.test.ts](../../lib/agent/memory/longterm-store.test.ts)（连真实 Supabase，4 case 全绿）

**Supabase CRUD 套路**：`await getSupabase().from("表").动作(...)` → `{ data, error }`，永远先看 error。
动作对照 SQL：`upsert`=INSERT..ON CONFLICT、`select+eq`=WHERE、`order/limit`=ORDER BY/LIMIT、`delete`=DELETE。

### 第 2 课技术选型与决策

- **表设计三决策**：key 加 `UNIQUE`（→ set 用 upsert 覆盖语义）；保留 `layer` 列（接口要返回 + 多层共用扩展位）；加 `updated_at`（配合 upsert 更新 + 未来遗忘策略）。
- **守卫返回值按类型区分**：`hasSupabaseConfig()` 不满足时，`get` 返 `null`、`list` 返 `[]`、`void` 方法 `return;` —— 必须匹配各自返回类型，不能一律 `return;`。
- **`toRecord` 映射器抽出复用**：snake_case 行 → camelCase 接口，get/list 共用，DRY。
- **测试连真库而非 mock**：真验证闭环；用 `it.skipIf(!hasConfig)` 没配则跳过（CI 不挂）；唯一 key（pid+时间戳）+ `afterAll` 兜底 forget，不留垃圾数据。

### 第 3 课：语义记忆实现（pgvector + recall）

收掉第一课拆 `SemanticMemoryStore` 的伏笔，实现按「意思」召回的 `recall`。

- 表 + 函数：[semantic-memories-schema.sql](../../docs/schemas/semantic-memories-schema.sql)（表 `agent_semantic_memories` + 函数 `match_memories`）
- 实现类：[semantic-store.ts](../../lib/agent/memory/semantic-store.ts)（`SemanticStore implements SemanticMemoryStore`）
- 语义召回测试：[semantic-store.test.ts](../../lib/agent/memory/semantic-store.test.ts)（连真实 Supabase + embedding API，3 case 全绿）

**一句话原理**：存时把文本转成 1024 维向量一起存；召回时把 query 也转向量，让数据库找向量最近的几条。

### 第 3 课核心概念

- **embedding/向量**：`EmbeddingClient.embedSingle(text)` → 1024 个数字；意思近则数字近。
- **余弦相似度 `<=>`**：SQL 里 `a <=> b` 是距离（越小越近），`1 - 距离` = 相似度（越大越像）。
- **HNSW 索引**：让「找最近向量」从暴力 O(n) 变近似最近邻（ANN），快几个数量级。`vector_cosine_ops` 对应查询里的 `<=>`。
- **数据库函数 vs 表**：`agent_semantic_memories` 是表（存数据）；`match_memories` 是**函数**（封装向量检索 SQL）。JS 客户端 `.select()` 写不出 `<=>`，所以把向量查询封装成 DB 函数，TS 端用 `.rpc("函数名", 参数)` 调。`.sql` 文件只是「安装说明书」，跑过后逻辑搬进 DB；改文件不影响 DB，要重跑才生效。
- **懒加载 EmbeddingClient**：它构造时校验 `DASHSCOPE_API_KEY`，不能在模块加载/constructor 就 new，延迟到首次用（set/recall）才创建。同 `getSupabase()` 单例套路。

### 第 3 课技术选型与决策

- **语义记忆单独建表**（不复用 `agent_memories` 加 embedding 列）：语义层有独有的 HNSW 索引 + match 函数，长期表会塞一堆 NULL embedding。印证「检索方式不同的层就该独立存储」。
- **阈值 0.3**（documents 是 0.7）：记忆召回宁可多召不漏，给模型自己判断。
- **set 内部生成向量**：调用方只给文本，向量在 set 里 `embedSingle` 生成，调用方不感知 embedding —— 封装的价值。
- **upsert 必须重算 embedding**：内容变了向量要跟着变，否则「新文本配旧向量」，recall 按旧语义召回（向量库经典一致性 bug）。
- **get/list 不 select embedding**：1024 维白传，只取需要的列（`COLS` 常量）。

### 第 4 课：记忆流动（编排层接入主循环）

把三层存储从「零件」变成「活系统」：对话自动召回、自动沉淀。

- 编排层：[memory-flow.ts](../../lib/agent/memory/memory-flow.ts)（`recallForPrompt` 召回 + `consolidate` 沉淀）
- 闭环测试：[memory-flow.test.ts](../../lib/agent/memory/memory-flow.test.ts)（端到端真调模型，3 case 全绿）
- 接入点：[runtime/index.ts](../../lib/agent/runtime/index.ts)（callModel 加 system）+ [route.ts](../../app/api/chat/route.ts)（召回注入 + 沉淀触发）

**完整闭环**：
```
用户对话 ──① recallForPrompt(query) ─→ 注入 system ─→ 模型带记忆回答
   └────── ③ consolidate(对话) [LLM抽取值得记的事实] ─→ 写回长期+语义
```

### 可信记忆生命周期

`20260718-trusted-memory-lifecycle.sql` 将直接 upsert 升级为可治理的记忆记录：每条记忆保存类型、来源、置信度、重要性、状态、生效区间、访问时间和用户原文证据。

写入管线现在按以下顺序执行：

1. 只从 user 消息抽取事实，并校验 `evidenceExcerpt` 必须逐字存在于用户原话；
2. 拒绝密码、令牌、私钥、银行卡号和身份证号；
3. 查询相同 key 和语义相似的旧记忆；
4. 决定 `ADD / UPDATE / INVALIDATE / NOOP`，忘记请求目标不明确时拒绝猜测；
5. 删除语义改为软失效，召回只读取 `active` 记忆；
6. 召回按相关性、重要性和新鲜度重排，并将内容作为不可信数据而非指令注入 prompt。

### 第 4 课核心概念

- **编排层 vs 执行层**：`memory-flow` 是「中间人/指挥」，对上给主循环提供 `recallForPrompt`/`consolidate` 两个入口，对下调 store 的 recall/set，**自己不碰数据库**。同 `tool-router` 解耦工具的思路。
- **Anthropic system 是顶层参数**：不在 `messages` 数组里，是 `client.messages.create({ system, messages })`。本项目原本无 system 层，借此补上。
- **强制结构化输出**：`tool_choice: { type: "tool", name }` 逼模型必走某工具 → 输出一定符合 `input_schema` 的 JSON，不用解析自然语言。同 eval 的 StructuredOutput 套路。
- **LLM 判断「什么值得记」**：不写规则，让模型读对话抽取长期事实。规则只能机械匹配字符串（「我对…」抓得到，「香菜我真没办法」漏掉），LLM 天然懂「过敏=长期、算术题=一次性」。
- **普通沉淀不阻塞响应**：偏好/事实抽取继续在回答后后台执行；显式“忘记/删除记忆”属于用户直接要求的数据变更，会在本轮同步完成。生产规模扩大后，普通沉淀应替换成带持久化和重试的任务队列。

### 第 4 课技术选型与决策

- **召回用 semantic.recall 而非 get**：对话开始时不知道该取哪个 key，只能按「意思相近」联想。
- **一条事实同时写长期+语义两层**：将来既能按 key 精确 get、也能按意思 recall。
- **key 由模型生成 + sessionId 命名空间**：同类事实用同一稳定 key 才能 upsert 覆盖；`ns = sessionId:key` 防不同用户互相覆盖。
- **抽取用 claude-sonnet-4-6**：抽取是简单任务，用 sonnet 足够且便宜（生产可换 haiku）。

### 第 5 课：会话记忆（Redis）

补齐最后一层，让 Agent 在同一会话内记住上下文。

- 类型定义：[types.ts](../../lib/agent/memory/types.ts)（`SessionMessage` + `SessionStore` 接口）
- 实现类：[session-store.ts](../../lib/agent/memory/session-store.ts)（`RedisSessionStore implements SessionStore`）
- 测试：[session-store.test.ts](../../lib/agent/memory/session-store.test.ts)（连真实本地 Redis，4 case 全绿）
- 接入点：[route.ts](../../app/api/chat/route.ts)（读历史补全 + 写入本轮消息）

### 第 5 课核心概念

- **Redis List 数据结构**：`RPUSH`（追加）+ `LRANGE 0 -1`（读全部）+ `DEL`（清空）+ `EXPIRE`（TTL）。会话消息天然有序、追加高效，比 String（大 JSON）高效得多。
- **TTL 刷新语义**：每次 `append` 都刷新 `EXPIRE`，从"最后一次活动"起算 2 小时，而不是从第一条消息算。否则活跃对话会提前过期。
- **`SessionStore` 不继承 `MemoryStore`**：访问模式是"列表追加/读取"，不是 key-value。强行套接口会扭曲语义。
- **`lazyConnect: true`**：不在构造时立刻连接，第一次真正读写才建连接。Redis 没跑时构造不报错。
- **模块级单例**：`const sessionStore = new RedisSessionStore()` 放顶层，整个进程复用同一个连接，不每次请求重新握手。
- **Serverless 局限**：本地 Redis 数据持久，但 Vercel 等 Serverless 部署连不上本地 Redis，生产需换 Upstash。因为接口解耦，只换实现类，主循环不动。

### 第 5 课技术选型与决策

- **本地 Redis 而非 Upstash**：学习阶段纯本机跑，本地最省事；接口解耦保证将来换 Upstash 只改实现类。
- **`messages.length === 1` 才补历史**：前端传完整历史时不覆盖（尊重调用方状态）；只传一条时才从 Redis 补，两种模式都支持。
- **助手回复从 `loopMessages` 取**：route 层拿不到流式输出的完整文本，但 `agentLoopResult.loopMessages` 里有最终的 assistant 消息，从那里取再存 Redis。

## 踩坑记录

- **`SemanticMemoryStore` 漏写 `extends MemoryStore`**：会导致语义层只有 `recall`、丢掉 get/set/forget/list，没法写入删除。子接口 = 父全部 + 新增。
- **`set` 漏 content 参数**：只有 key 没有「存什么」，等于给钥匙不给东西。
- **接口成员逗号/分号混用**：TS 两者都合法但要风格统一，项目里统一用分号。
- **`DEFAULT NOW()` 只在 INSERT 生效**：upsert 走 UPDATE 分支不刷新 `updated_at`，必须显式传 `updated_at: new Date().toISOString()`。
- **`single()` 查不到会抛错**：要「查不到返回 null」必须用 `maybeSingle()`。
- **坑3｜Node 20 + supabase-js 的 WebSocket 报错**：`createClient` 初始化 realtime 客户端，Node <22 无原生 WebSocket 直接抛错（即便根本不用 realtime）。报错信息建议装 `ws`，但实际 `ws` 已被装；真正修法是在 vitest setupFiles（[test-setup.ts](../../lib/test-setup.ts)）里把 `ws` 挂到 `globalThis.WebSocket`，只动测试环境、不改业务代码。
- **坑4｜接口早期漏字段，后期功能才暴露**：第 1 课定 `MemoryRecord` 时只加了 `id`（db 主键），漏了 `key`（业务键）。长期记忆没暴露问题，直到第 3 课 `recall` 想用 `key` 区分记录，才发现接口没这字段、`toRecord` 也没映射，表现为 `h.key === undefined`。修法：接口补 `key` + 两个 store 的 `toRecord` 都补 `key: row.key`。教训：早期接口的缺字段会在后期功能上爆出来。
- **坑5｜测试清理放错位置导致向量召回被污染**：第 3 个用例把 `forget(k)` 写在断言**后面**，断言一失败就抛异常、跳过清理 → 垃圾数据累积（跑几次表里堆了 7 条「美式咖啡」）→ recall 召回全是残留、目标被挤出前 N → 又失败又不清理，恶性循环。表面「召回不准」，根因是「测试不自清理」。修法：清理一律放 `afterAll`，把所有用到的 key（含临时 key）统一登记清理；断言改成不依赖排名的稳健写法（验证「改内容后对新 query 的 score 升高」）。
- **坑6｜配置一直是坏的，被 mock/手测掩盖**：`config.ts` 的 `model: 'deepseek-v4-pro'` + `apiKey: ANTHROPIC_API_KEY` 从未在真实路径用过——eval 走 mock 轨、聊天靠前端手测。`consolidate` 是**第一个在测试里真调模型的代码**，把坏配置炸出来。实测有效组合是 `ANTHROPIC_AUTH_TOKEN`(Bearer) + 模型 `claude-sonnet-4-6`（该端点其实是 Claude 代理）。教训：mock 轨绿 ≠ 真实链路通。⚠️ 主项目 config 仍坏，待单独修。
- **坑7｜SDK 自动注入无效 apiKey 覆盖 authToken → 401**：环境里 `ANTHROPIC_API_KEY` 无效，Anthropic SDK 默认会自动读它走 `x-api-key` 头，且优先于 Bearer，导致 401。诊断关键：隔离测试三种鉴权组合，发现 `仅 authToken` 报 **503 model_not_found**（不是 401）——503 反而证明 token 有效、只是模型名不对。修法：`new Anthropic({ apiKey: null, authToken })` 显式禁用自动注入，强制走 Bearer。

## 延伸阅读

- 解耦同款套路：[tool-router](../../lib/agent/tools/tool-router.ts) 解耦工具与主循环。
- 复用的基础设施：[supabase.ts](../../lib/platform/supabase.ts)（向量检索）、[embedding.ts](../../lib/knowledge/embedding.ts)（1024 维向量）。
