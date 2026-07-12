# LG 个人知识助手 - 待办列表

> 根据 ROADMAP.md 生成，按优先级排序  
> 完成一项就在前面打勾 ✅

---

> ⚠️ **文档状态校准（2026-06-13）**：本文件早期“当前状态”严重滞后于真实代码。
> 经核对实际实现后重写。下面的「已实现」反映 `lib/agent/` 与 `lib/knowledge/` 的真实代码。

## 当前项目状态（已实现）

**核心对话**
- ✅ 基础流式对话（Anthropic SDK + DeepSeek 模型，`lib/agent/models.ts` 支持模型选择）
- ✅ 输入框升级：textarea、Enter 发送、Shift+Enter 换行、发送后聚焦
- ✅ 停止生成：前端 abort、后端安全中断、部分回复落库
- ✅ Markdown 渲染 + 代码高亮
- ✅ 多会话管理 + **Redis 会话持久化**（`RedisSessionStore`，进程外可恢复历史）

**Agent 能力（路线图原标“未做”，实际已实现）**
- ✅ **Agent Runtime + Agentic Loop** — `lib/agent/runtime/index.ts`：`runAgentLoop`、`maxToolIterations` 轮数保护、`max_iterations` 停止原因、`getToolCallKey` 死循环识别
- ✅ **上下文压缩** — `runtime/compaction.ts`（`compactLoopMessages`）
- ✅ **Token 预算** — `runtime/budget.ts`
- ✅ **结构化事件协议 + 流式管道** — `runtime/events.ts`、`streamModelResponse`、`forwardTextStream`
- ✅ **Tool Use 引擎** — `tools/tool-router.ts`：解析 tool_use、执行、回传 tool_result，支持多轮
- ✅ **Tool Registry** — `tools/registry.ts`：注册 / 查找 / 输出 schema
- ✅ **工具权限分级** — `riskLevel`: `safe` / `confirm`（走审批）/ `dangerous`（拦截），`runtime policy` + rateLimit
- ✅ **7 个内置工具** — `get_current_time` / `calculator` / `search_notes` / `create_todo` / `daily_leetcode` / `leetcode_wrong_book` / `web_search`(Tavily)
- ✅ **审批路由** — `app/api/tools/confirm/route.ts`

**RAG（路线图原标“未做”，实际已打通）**
- ✅ **RAG 全链路** — `lib/knowledge/`：`NotionClient` 读取 → `chunkText` 分块 → `EmbeddingClient` 向量化 → `syncNotionPages` 入库 → `RAGRetriever` 检索
- ✅ **RAG 已接入对话** — `search_notes` 工具内部调用 `RAGRetriever`，模型可自主检索知识库

**记忆系统（路线图原标“未做”，实际已实现）**
- ✅ **三层记忆 store** — `memory/session-store.ts`(Redis) / `memory/semantic-store.ts`(`agent_semantic_memories` + `match_memories` RPC) / `memory/longterm-store.ts`(`agent_memories`)
- ✅ **记忆 flow** — `memory/memory-flow.ts`：`recallForPrompt`（召回注入）+ `consolidate`（异步固化）

**观测与质量**
- ✅ **Trace 链路** — `runtime/trace.ts` + `trace-store.ts`，`formatTraceTree`，写 `traces` 表
- ✅ **Eval harness** — `lib/agent/eval/`：cases / assertions / runner / mock-models，`npm run test:eval`
- ✅ 基础质量检查：TypeScript / lint / build 已跑通

---

## 真正的剩余缺口（按价值排序）

- [ ] **P0 — DB migration 收口**
  - `docs/schemas/` 散着 9 个 .sql（含 `sessions` / `memories` / `semantic-memories` / `traces` / leetcode 系列）
  - `scripts/init-db.sh` 仅提示手动跑 3 个文件，未覆盖 memories/semantic/traces
  - 整理成统一建表入口或 migration 文档，确认所有表都被覆盖、外键 `ON DELETE CASCADE`

- [ ] **P1 — 会话持久化到 Supabase（可选）**
  - 当前会话历史在 Redis（`RedisSessionStore`），适合缓存但非长期归档
  - 若要长期持久化 + 跨设备，需补 `sessions` / `messages` 表写入链路
  - 前端 `app/_hooks/use-chat-manager.ts` 目前不直接落库，依赖后端 Redis

- [ ] **M0.7 会话标题手动重命名**
  - 会话列表支持进入编辑态
  - 标题修改后调用 `updateSessionTitle`
  - 刷新后标题保持不变

- [ ] **M0 Dev Server 缓存稳定性**
  - 排查 `.next/cache/webpack` 偶发 ENOENT
  - 必要时补充清理和重启说明

---

## RAG 改造 TODO（按执行顺序）

> 目标：把当前“能用的向量检索工具”升级为更稳定的 Agentic RAG 知识库。
> 参考 `/Users/lg/Desktop/sitor-agent-fundamentals/20_RAG_全流程：从一堆文档到_Agent_能用的知识库.md` 与 `21_检索优化：语义相似_≠_任务相关，怎么让_Agent_找到真正需要的信息？.md`。

### P0 - 先把基础链路变得可操作、可维护

- [x] **RAG-01 同步 CLI 入口**
  - 增加 `scripts/rag-sync.ts` 或 `.cjs`
  - 支持 `npm run rag:sync <notion_page_id>`
  - 支持多个 page id 批量同步
  - 失败时打印 page id、错误信息、已完成数量

- [x] **RAG-02 检索 CLI 入口**
  - 增加 `npm run rag:search "query"`
  - 输出命中文档标题、相似度、URL、chunk 摘要
  - 用于不启动前端时快速验证 RAG 入库和召回

- [x] **RAG-03 Notion 递归读取**
  - `NotionClient.getPageBlocks` 支持递归读取 `has_children` blocks
  - 保留 heading 层级上下文
  - 支持 paragraph、heading、list、todo、toggle、quote、callout、code
  - 避免循环/过深递归，加入最大深度保护

- [x] **RAG-04 Chunk metadata 增强**
  - 每个 chunk 写入 `page_title`、`page_url`、`heading_path`
  - 写入 `start_char`、`end_char`、`chunk_index`
  - 写入 `content_hash`、`embedding_model`、`chunker_version`
  - 更新 `docs/schemas/database-schema.sql`

- [x] **RAG-05 增量同步**
  - 页面级 hash：Notion 内容未变则跳过
  - 页面变更时整页重建 chunk；chunk 级 diff 延后到分块策略稳定后再做
  - embedding 模型或 chunker 版本变化时强制重建
  - 同步结果区分 `created` / `updated` / `skipped` / `failed`

- [x] **RAG-06 文档与代码对齐**
  - 更新 `docs/rag/rag-implementation.md`
  - 明确当前形态是 `search_notes` 工具驱动的 Agentic RAG
  - 移除旧 schema 示例中 `notion_page_id UUID` 等不再匹配的字段

### P1 - 提升检索质量

- [x] **RAG-07 递归分块策略**
  - 从固定字符分块升级为“段落/标题 -> 句子 -> 字符兜底”
  - chunk size 以 token 或近似 token 为目标，而不是纯字符
  - 保留 overlap，但避免 overlap 导致重复结果过多

- [x] **RAG-08 混合检索**
  - 在 PostgreSQL 中增加全文检索列或 generated tsvector
  - `match_documents` 升级为 vector + keyword 双路召回
  - 做分数归一化后融合，初始权重 `vector 0.7 / keyword 0.3`
  - 精确术语、错误码、API 名称优先受益

- [x] **RAG-09 候选采样**
  - 最终返回 topK 前，先召回 `topK * 4` 候选
  - 设置候选上限，例如 50 或 100
  - `search_notes` 默认 limit 与候选数量分离

- [x] **RAG-10 MMR 去重**
  - 对候选结果做 Maximal Marginal Relevance
  - 初始 `lambda = 0.7`
  - 先用 Jaccard 相似度做零成本去重
  - 避免同一页面/同一小节重复 chunk 挤满 topK

- [x] **RAG-11 Reranker 精排**
  - 第一阶段召回 20-50 条候选
  - 第二阶段用轻量规则 reranker 给 query/chunk 相关性打分
  - 返回时保留 `vector_score`、`keyword_score`、`rerank_score`
  - trace 中展示重排前后顺序

- [x] **RAG-12 Query 改写**
  - 支持规则 query rewrite：清理疑问词、抽取技术术语、生成 2-3 个检索 query
  - HyDE / LLM 子问题分解延后到需要模型调用版本时再做
  - 搜索成本可配置，默认只在低召回或复杂问题时开启

### P2 - 可观测、可评估、可产品化

- [x] **RAG-13 RAG Trace 增强**
  - trace 记录原始 query、改写 query、召回候选、各类 score
  - 前端 trace 页展示 search_notes 的检索细节
  - 支持快速判断“没查到”还是“查到了但排序错”

- [x] **RAG-14 引用来源体验**
  - `search_notes` 来源在回答结束后展示标题、链接、相似度、摘录
  - 前端支持点击打开 Notion 页面
  - 避免只把来源塞到模型上下文，用户看不到依据

- [x] **RAG-15 RAG Eval 数据集**
  - 增加 `lib/agent/eval/rag-cases.ts`
  - 每条 case 包含 question、expected_page_id、expected_keywords
  - 指标：recall@5、MRR、关键词覆盖、无结果率
  - 加入 `npm run test:rag`

- [x] **RAG-16 知识库管理界面**
  - 展示已同步页面、chunk 数、最后同步时间
  - 支持查看页面链接、page id、embedding 模型、chunker 版本
  - 手动同步/重建索引延后到下一轮交互增强

- [x] **RAG-17 多数据源扩展**
  - Markdown 文件导入
  - 网页 URL 抓取入库延后到 loader 接口稳定后
  - PDF/Word 后续接入专门解析器

---

## Phase 1 - 核心体验完善

- [x] **1.1 RAG 知识库问答**（基础链路已完成）
  - [x] 接入 Notion API，同步笔记内容并分块（`lib/knowledge/notion.ts` + `sync.ts` + `chunking.ts`）
  - [x] 调用 Embedding 模型生成向量，写入 Supabase（`lib/knowledge/embedding.ts`）
  - [x] 用户提问时向量检索，结果通过 `search_notes` 工具注入对话（`lib/knowledge/retriever.ts`）
  - [x] 混合检索策略：向量相似度 + 关键词融合排序
  - [x] 回答中标注引用来源（页面标题 + 链接）的前端展示

- [~] **1.2 对话持久化 + Prompt Pipe**
  - [x] 会话历史持久化（**Redis** `RedisSessionStore`，非 Supabase）
  - [x] 后端能恢复历史对话（前端只传一条时从 Redis 补回）
  - [ ] 长期持久化到 Supabase `sessions`/`messages` 表（**未做**）
  - [ ] 支持对话标题编辑和重命名（**未做**，见 M0.7）

- [x] **1.3 输入体验升级**（已完成）
  - [x] 多行 `<textarea>`，Shift+Enter 换行
  - [x] 支持停止生成（前端 abort + 后端中断）
  - [x] 消息发送后自动聚焦输入框

- [ ] **1.4 Markdown 渲染增强**
  - [ ] 代码块添加一键复制按钮
  - [ ] 支持表格、LaTeX 公式渲染
  - [ ] 支持图片 / 链接的正确展示

---

## Phase 2 - Agent 核心能力（重点）

### 2A. 单 Agent 基础能力（P0/P1 优先级）

> ✅ **2A.0 / 2A.1 / 2A.4 / 2A.6 已基本实现**（见顶部「当前项目状态」）。
> 真正未做：**2A.2 文件工具**、**2A.3 终端工具**、**2A.5 规划反思**、**2A.7 MCP**、**2A.8/2A.9 工具组装与 Profile**。

- [x] **2A.0 Agent Runtime - 运行时基础设施**（已实现，`lib/agent/runtime/`）
  - 生命周期管理：初始化 → Prompt 组装 → LLM 调用 → 工具执行 → 输出响应
  - Tool Registry：所有工具（内置 / MCP / Plugin）统一注册
  - 权限层：工具执行前的权限检查（白名单 / 审批 / 拦截）
  - Hook 管线：pre-execute / post-execute Hook，支持审计日志、结果过滤
  - 沙箱隔离：文件操作限定目录、命令执行资源限制
  - 上下文注入：system prompt + 记忆 + RAG 结果 + 工具描述按优先级拼装
  - 流式输出管道：统一协议推送 LLM 文本 + 工具调用过程

- [x] **2A.1 Tool Use 工具调用引擎**（已实现，`tools/tool-router.ts` + `registry.ts`）
  - 后端实现 Anthropic Tool Use 协议（function calling）
  - 设计统一的 Tool 接口规范（name, description, input_schema, execute）
  - 构建 Tool Router：解析 `tool_use` block，路由到对应工具执行
  - 支持单次对话中多轮工具调用
  - 前端适配：识别 `tool_use` / `tool_result` 消息类型，结构化卡片展示

- [ ] **2A.2 内置工具集 - 文件系统操作**
  - `read_file` - 读取指定路径文件内容，支持行号范围
  - `write_file` - 创建新文件或完整覆写
  - `edit_file` - 基于 search/replace 的精确编辑
  - `list_directory` - 列出目录结构
  - `search_files` - grep 搜索文件内容（支持正则）
  - 安全机制：沙箱目录白名单、敏感文件过滤、写操作需用户确认
  - 前端展示：文件读取结果代码高亮、写入/编辑以 diff 视图展示

- [ ] **2A.3 内置工具集 - 终端命令执行**
  - `run_command` - 在服务端沙箱中执行 shell 命令
  - 流式输出：命令执行过程实时推送到前端（stdout + stderr）
  - 安全机制：命令白名单模式、危险命令拦截、执行超时控制、资源限制
  - 前端展示：终端风格输出渲染、运行中状态指示 + 手动终止按钮

- [x] **2A.4 Agentic Loop - 自主多步执行**（已实现：`runAgentLoop`、`maxToolIterations`、`getToolCallKey` 死循环识别）
  - 实现 Agent Loop：while (stop_reason !== 'end_turn') { 思考 → 调工具 → 回传结果 }
  - 支持模型在一次用户请求中自主执行多步操作
  - 循环保护：最大迭代次数（如 20 轮），超出后暂停并询问用户
  - 死循环检测：连续相同工具调用自动识别并打断
  - Token 预算、工具并发执行、全过程流式展示、用户随时中断

- [ ] **2A.5 规划与反思能力（Plan → Execute → Verify）**
  - Planning 阶段：模型先输出执行计划，前端可视化 checklist
  - Execution 阶段：按计划逐步执行，遇到意外自动调整
  - Verification 阶段：执行完毕后自动验证结果，失败自动进入修复循环

- [x] **2A.6 记忆系统**（已实现：三层 store + `recallForPrompt`/`consolidate`，前端管理面板未做）
  - 记忆存储层：基于 Supabase 的 `memories` 表，记忆向量化支持语义检索
  - 记忆类型：用户画像（user）、反馈偏好（feedback）、项目知识（project）、事实参考（reference）
  - 记忆生命周期：自动提取、显式记忆、主动召回、衰减与更新、遗忘机制
  - 记忆工具：`save_memory`, `search_memory`, `list_memories`, `delete_memory`
  - 前端展示：记忆管理面板、对话中标注"正在使用记忆"

- [ ] **2A.7 MCP 协议支持**
  - MCP Client 实现：支持通过 stdio / SSE 连接 MCP Server
  - 自动发现 MCP Server 暴露的 Tools / Resources / Prompts
  - 将 MCP Server 的工具自动注册到 Tool Registry
  - MCP Server 配置管理：`mcp-servers.json` 配置文件
  - 前端 MCP 管理面板：添加 / 移除 / 启停 MCP Server

- [ ] **2A.8 工具组装应用场景**
  - 代码分析 Agent：读取项目结构 → 分析代码 → 输出报告
  - Research Agent：联网搜索 → 聚合多源信息 → 生成结构化摘要
  - Vibe Coding：用户描述需求 → Agent 自主编写代码 → 运行验证 → 迭代修改

- [ ] **2A.9 工具 Profile 过滤与延迟加载**
  - 工具 Profile 分组：按场景（编码 / 搜索 / 文件管理）分组
  - 根据用户意图动态加载相关工具子集
  - 工具优先级排序：高频工具优先、低频工具延迟加载

---

### 2B. Harness 多 Agent 协作架构（P2/P3 优先级）

> 建立在 2A 单 Agent 基础能力之上，用于复杂、长期运行的任务  
> 参考：Anthropic Harness Engineering 官方实践

- [ ] **2B.1 Planner-Generator-Evaluator 三角架构**
  - Planner Agent：用户需求 → `spec.md` + `features.json`
  - Generator Agent：`spec.md` → 代码 + `implementation.md`（基于 2A 所有工具能力）
  - Evaluator Agent：`implementation.md` → `evaluation.md`（与 Generator 完全分离，避免自我评估偏差）
  - Agent 间通信：通过文件传递状态（不是内存共享）

- [ ] **2B.2 长期运行支持（跨上下文窗口）**
  - 初始化 Agent：创建 `init.sh`、`claude-progress.txt`、`features.json`（JSON 格式防止篡改）、初始 git commit
  - 编码 Agent：标准工作流程（读取进度 → 选择特性 → 实现 → 提交 → 更新进度）
  - 上下文重置机制（不是压缩）
  - 四大失败模式预防：过早完成、未文档化 bug、不充分测试、启动困难

- [ ] **2B.3 生成-评估循环**
  - Generator ↔ Evaluator 迭代循环（最多 10 轮）
  - 防止过早完成：不可删除或编辑测试
  - 浏览器自动化集成：Puppeteer MCP，让 Evaluator 像真实用户一样测试

- [ ] **2B.4 可观测性与追踪**
  - OpenTelemetry 集成、AgentOps 监控、审计日志、成本追踪

- [ ] **2B.5 前端可视化**
  - 多 Agent 执行进度实时展示
  - Agent 依赖关系图（DAG）
  - 支持手动干预：暂停、终止、重新分配任务

---

## Phase 3 - 工具生态扩展

- [ ] **3.1 Skill 技能系统**
  - 可扩展的技能插件架构
  - 内置技能：`/translate`, `/summarize`, `/code-review`, `/search`, `/todo`, `/memo`
  - 用户通过 `/` 前缀触发，输入框支持自动补全和参数提示

- [ ] **3.2 Plugin 架构**
  - 标准化 Plugin manifest（name、tools、prompts、permissions）
  - Plugin 注册 / 安装 / 卸载机制
  - Plugin 市场 / 目录

- [ ] **3.3 Channel 抽象**
  - Channel 接口抽象：统一的消息输入/输出协议
  - 内置 Channel：Web UI、飞书群机器人、微信/企微、Slack、Telegram、API 接口
  - 跨 Channel 共享同一个 Agent 实例

- [ ] **3.4 定时任务与自动化**
  - 用户可通过对话创建定时任务
  - 后端调度引擎（node-cron / BullMQ）
  - 定时任务工具：`create_cron_job`, `list_cron_jobs`, `delete_cron_job`

- [ ] **3.5 文件上传与解析**
  - 支持上传 PDF / Word / TXT / Markdown / 图片文件
  - 服务端解析后注入对话上下文

- [x] **3.6 联网搜索**（已实现）
  - [x] 集成 Tavily（`@tavily/core`，`lib/agent/tools/web-search.ts`）
  - [x] 作为 `web_search` 工具注册，模型自主决定何时搜索

---

## Phase 4 - 知识管理体系

- [ ] **4.1 Notion 自动同步**
  - 定时任务自动拉取 Notion 更新内容
  - 增量同步：只处理变更的页面

- [ ] **4.2 知识库管理界面**
  - 可视化展示已入库的文档列表
  - 支持手动上传文档到知识库
  - 按标签 / 来源筛选和搜索已有文档

- [ ] **4.3 多数据源接入**
  - 支持从 GitHub Repo、Yuque、飞书文档等导入
  - 支持网页 URL 抓取并入库

---

## Phase 5 - Context Engineering + 高级交互

- [ ] **5.1 上下文管理优化**
  - Token 估算、工具结果截断、TTL 修剪

- [ ] **5.2 Prompt Cache 与成本追踪**
  - 接入 Anthropic Prompt Cache
  - 成本追踪面板：token 消耗、缓存命中率、费用估算

- [ ] **5.3 多轮对话优化**
  - 对话分支、相关问题推荐

- [ ] **5.4 搜索与回顾**
  - 全局搜索：跨所有会话搜索历史消息
  - 对话收藏 / 置顶

- [ ] **5.5 System Prompt 管理**
  - UI 面板自定义系统提示词
  - 预设多种角色模板

---

## Phase 6 - 工程化与部署

- [ ] **6.1 权限系统**
  - 用户认证：Supabase Auth / NextAuth.js
  - 用户数据隔离、权限分级

- [ ] **6.2 用量控制**
  - Token 消耗统计与可视化
  - 请求频率限制、API Key 管理界面

- [ ] **6.3 响应式适配**
  - 移动端适配、PWA 支持、深色 / 浅色主题切换

- [ ] **6.4 多模型路由 + Config 系统**
  - 智能路由：根据任务类型自动选择模型
  - Fallback：主模型不可用时自动切换备用
  - 统一 Config 管理，热更新

- [ ] **6.5 部署与运维**
  - Docker 容器化部署方案
  - 错误监控（Sentry）、CI/CD 流水线

---

## 优先级建议（已按真实进度重排，2026-06-13）

> Runtime / Tool Use / Agentic Loop / RAG / 记忆 / 联网搜索 / 输入体验 均已完成，不再列入待办。

**P0（先做，低风险高收益）**：
- DB migration 收口（统一建表入口，覆盖 memories/semantic/traces）
- Markdown 渲染增强（代码复制按钮、表格、LaTeX）—— 纯前端，体验提升明显
- RAG 引用来源前端展示（命中页面标题 + Notion 链接可点）

**P1（核心能力扩展）**：
- Phase 2A.2 文件系统操作工具（read/write/edit/list/search，接已有 `riskLevel` 权限框架）
- Phase 2A.3 终端命令执行工具（run_command + 危险命令拦截，走 `/api/tools/confirm` 审批）
- Phase 2A.5 规划与反思能力（Plan → Execute → Verify）
- 会话标题手动重命名（M0.7）
- 会话长期持久化到 Supabase（可选，当前 Redis 已可用）

**P2（生态扩展）**：
- Phase 2A.7 MCP 协议支持
- Phase 2A.8/2A.9 工具组装场景 + Profile 过滤
- Phase 3.1 Skill 技能系统 / 3.2 Plugin 架构 / 3.4 定时任务 / 3.5 文件上传
- Phase 5.1-5.2 Context Engineering（部分已有 compaction/budget 铺垫）

**P3（长期）**：
- Phase 2B 多 Agent 协作（Planner-Generator-Evaluator）
- Phase 3.3 Channel 抽象 / 6.1 权限系统 / 6.4 多模型路由 / 6.5 部署运维
- Phase 4 知识管理体系 / 5.3-5.5 高级交互

---

**建议执行路径**：
1. **收口**：DB migration + RAG 引用展示 + Markdown 增强（巩固已有能力）
2. **补工具**：文件工具 → 终端工具（接现有权限/审批框架）
3. **提质量**：规划反思 + 会话标题/持久化
4. **扩生态**：MCP → 工具组装 → Skill/Plugin
5. **进阶**：多 Agent + 工程化部署
