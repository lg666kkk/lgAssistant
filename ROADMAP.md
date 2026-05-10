# LG 个人知识助手 — 功能规划

> 当前状态：已实现基础流式对话 + 多会话管理 + Supabase 向量存储基础设施  
> 技术栈：Next.js 14 / Anthropic SDK / Supabase / Notion API / TailwindCSS  
> 产品定位：具备 Agent 能力的个人知识助手 — 不只是对话，更能自主规划、调用工具、执行任务

---

## Phase 1 — 核心体验完善

从"能用"到"好用"的基础功能。

### 1.1 RAG 知识库问答
- 接入 Notion API，自动同步笔记内容并分块（chunking）
- 调用 Embedding 模型生成向量，写入 Supabase `documents` 表
- 用户提问时先做向量检索，将相关文档片段注入 system prompt
- 混合检索策略：向量相似度（语义）+ BM25（关键词）融合排序，提升召回质量
- 回答中标注引用来源（页面标题 + 链接）

### 1.2 对话持久化 + Prompt Pipe
- 会话列表和消息记录持久化到 Supabase（当前仅存于内存）
- 刷新页面 / 重新打开后恢复历史对话
- 支持对话标题编辑和重命名
- 模块化 Prompt 组装管道（Prompt Pipe）：system prompt + 记忆 + RAG 结果 + 工具描述 + 用户消息，按优先级动态拼装

### 1.3 输入体验升级
- 将单行 `<input>` 替换为多行 `<textarea>`，支持 Shift+Enter 换行
- 支持停止生成（前端调用 abort，后端中断流）
- 消息发送后自动聚焦输入框

### 1.4 Markdown 渲染增强
- 代码块添加一键复制按钮
- 支持表格、LaTeX 公式渲染
- 支持图片 / 链接的正确展示

---

## Phase 2 — Agent 核心架构（重点）

这是整个系统的分水岭 — 从"聊天机器人"进化为"能干活的 Agent"。

### 2.0 Agent Harness — 运行时外壳
> 整个 Agent 的"房子" — 所有能力都挂载在它上面。

- Harness 是包裹在 LLM 外面的运行时容器，负责：
  - **生命周期管理**：初始化 → 接收输入 → Prompt 组装 → LLM 调用 → 工具执行 → 输出响应 → 清理
  - **Tool Registry 挂载点**：所有工具（内置 / MCP / Plugin）统一注册到 Harness
  - **权限层**：工具执行前的权限检查（白名单 / 审批 / 拦截）
  - **Hook 管线**：pre-execute / post-execute Hook，支持审计日志、结果过滤、自定义逻辑
  - **沙箱隔离**：文件操作限定目录、命令执行资源限制、MCP Server 进程隔离
  - **上下文注入**：自动将 system prompt、记忆、RAG 结果、工具描述按优先级拼装到 messages
  - **流式输出管道**：统一的 streaming 协议，将 LLM 文本 + 工具调用过程推送给前端
- Harness 是可配置的：通过 Config 文件控制行为（允许哪些工具、沙箱范围、Hook 列表等）
- 后续所有能力（Tool、Loop、Memory、MCP）都是"插入 Harness 的模块"

### 2.1 Tool Use 工具调用引擎
> 基础设施：让模型能调用工具，而不是只输出文本。

- 后端实现 Anthropic Tool Use 协议（function calling），替换当前纯文本流式响应
- 设计统一的 Tool 接口规范：
  ```
  interface Tool {
    name: string
    description: string
    input_schema: JSONSchema
    execute(params): Promise<ToolResult>
  }
  ```
- 构建 Tool Router：解析模型返回的 `tool_use` block，路由到对应的工具执行，将结果回传模型
- 支持单次对话中多轮工具调用（模型调工具 → 拿到结果 → 继续思考 → 再调工具 → ... → 最终回答）
- 前端适配：识别 `tool_use` / `tool_result` 消息类型，以结构化卡片展示工具调用过程

### 2.2 内置工具集 — 文件系统操作
> 让助手能读写文件，像 Claude Code 一样操作项目。

- **read_file** — 读取指定路径文件内容，支持行号范围
- **write_file** — 创建新文件或完整覆写
- **edit_file** — 基于 search/replace 的精确编辑（非覆写，减少出错）
- **list_directory** — 列出目录结构
- **search_files** — grep 搜索文件内容（支持正则）
- 安全机制：
  - 沙箱目录白名单，禁止操作系统关键路径
  - 敏感文件过滤（.env、credentials 等不可读写）
  - 所有写操作需用户确认（前端弹窗 approve/deny）
- 前端展示：
  - 文件读取结果以代码块 + 语法高亮展示
  - 写入/编辑操作以 diff 视图展示变更
  - 目录结构以树形组件展示

### 2.3 内置工具集 — 终端命令执行
> 让助手能跑命令，真正"动手干活"。

- **run_command** — 在服务端沙箱中执行 shell 命令
- 流式输出：命令执行过程实时推送到前端（stdout + stderr）
- 安全机制：
  - 命令白名单模式（默认只允许安全命令：ls、cat、grep、node、python、npm、git 等）
  - 危险命令拦截（rm -rf、sudo、chmod 777 等需用户显式确认）
  - 执行超时控制（默认 30s，防止死循环）
  - 资源限制（内存、CPU）
- 前端展示：
  - 终端风格的输出渲染（黑底绿字 / 等宽字体）
  - 运行中状态指示 + 手动终止按钮
  - 执行结果（exit code、耗时）展示

### 2.4 Agentic Loop — 自主多步执行
> 核心能力：模型自主规划步骤，循环调用工具，直到任务完成。

- 实现 Agent Loop：
  ```
  while (true) {
    response = await llm.chat(messages)     // 模型思考
    if (response.stop_reason === 'end_turn') break  // 任务完成
    if (response.stop_reason === 'tool_use') {
      result = await executeTool(response.tool_calls)  // 执行工具
      messages.push(toolResult)            // 结果回传
    }
  }
  ```
- 支持模型在一次用户请求中自主执行多步操作（如：读文件 → 分析 → 修改 → 运行测试 → 报告结果）
- 循环保护：设置最大迭代次数（如 20 轮），超出后暂停并询问用户是否继续
- 死循环检测：连续相同工具调用自动识别并打断
- API 容错：重试机制（指数退避）、超时处理、模型不可用时降级
- Token 预算：单次请求的 token 上限，接近时自动摘要压缩上下文
- 工具并发执行：多个独立工具调用可并行执行，提升效率
- 工具结果截断：输出过长时自动截取关键部分，避免撑爆上下文
- 全过程流式展示：每一步的思考、工具调用、结果都实时推送到前端
- 用户可随时中断 Agent Loop

### 2.5 规划与反思能力（Plan → Execute → Verify）
> 让 Agent 先想清楚再动手，做完再检查。

- **Planning 阶段**：
  - 收到复杂任务时，模型先输出执行计划（步骤列表）
  - 计划以可视化 checklist 展示在前端
  - 用户可审核 / 修改计划后再执行（可选：自动执行模式）
- **Execution 阶段**：
  - 按计划逐步执行，每完成一步自动勾选
  - 遇到意外情况（命令报错、文件不存在）时自动调整计划
- **Verification 阶段**：
  - 执行完毕后，模型自动验证结果（如运行测试、检查文件内容）
  - 输出执行摘要：做了什么、改了哪些文件、测试是否通过
  - 如果验证失败，自动进入修复循环
- 通过 system prompt 中的 planning 指令引导模型行为

### 2.6 记忆系统（Memory System）
> 让 Agent 拥有跨会话的长期记忆，越用越懂你。

- **记忆存储层**：
  - 基于 Supabase 的持久化记忆存储（memories 表）
  - 每条记忆包含：内容、类型、创建时间、更新时间、来源会话 ID
  - 记忆向量化，支持语义检索（复用 RAG 的 embedding 基础设施）

- **记忆类型**：
  - **用户画像（user）**：用户的角色、偏好、技术栈、沟通风格等
    - 示例："用户是前端工程师，偏好 TypeScript + React，喜欢简洁的代码风格"
  - **反馈偏好（feedback）**：用户对 Agent 行为的纠正和认可
    - 示例："用户不喜欢冗长的解释，回答要简洁直接"
    - 示例："代码中不要写注释，除非逻辑非常隐晦"
  - **项目知识（project）**：当前项目的背景、决策、进展
    - 示例："正在做个人助手项目，目标是对标 Claude Code 的 Agent 能力"
  - **事实参考（reference）**：外部资源的指针和说明
    - 示例："API 文档在 Notion 的 'Tech Docs' 数据库中"

- **记忆生命周期**：
  - **自动提取**：Agent 在对话过程中自动识别值得记住的信息（通过 system prompt 引导）
  - **显式记忆**：用户说"记住：xxx"时立即存储
  - **主动召回**：每次对话开始时，根据用户输入语义检索相关记忆，注入上下文
  - **衰减与更新**：记忆有时效性，过时的自动标记为 stale；冲突时以新信息为准
  - **遗忘机制**：用户说"忘掉 xxx"时删除对应记忆

- **记忆工具（作为 Tool 注册到 Agent）**：
  - `save_memory` — 保存一条记忆（type, content, metadata）
  - `search_memory` — 按语义搜索相关记忆
  - `list_memories` — 列出某类型的所有记忆
  - `delete_memory` — 删除指定记忆

- **前端展示**：
  - 记忆管理面板：查看、搜索、编辑、删除所有记忆
  - 对话中标注"正在使用记忆"（如小图标提示），让用户知道 Agent 在用哪些记忆
  - 设置页面：开关记忆功能、选择自动记忆的激进程度

- **记忆体检**：
  - 记忆冲突检测：新记忆与旧记忆矛盾时自动标记
  - 定期用 LLM 审查记忆库，清理无效 / 过时 / 矛盾的记忆
  - 相似记忆自动归并，减少冗余

### 2.7 MCP 协议支持（Model Context Protocol）
> 接入 MCP 标准协议，让 Agent 能即插即用地连接海量外部工具和数据源。

- **MCP 是什么**：
  - Anthropic 提出的开放协议，定义了 AI 模型与外部工具/数据源之间的标准化通信方式
  - 类比"AI 世界的 USB 接口" — 一次实现协议，即可接入所有兼容的 MCP Server

- **MCP Client 实现**：
  - 在 Agent 后端实现 MCP Client，支持通过 stdio / SSE 两种传输方式连接 MCP Server
  - 自动发现 MCP Server 暴露的 Tools / Resources / Prompts
  - 将 MCP Server 的工具自动注册到 Agent 的 Tool Registry（与内置工具统一调度）
  - 支持同时连接多个 MCP Server

- **MCP Server 配置管理**：
  - 配置文件（`mcp-servers.json`）管理已接入的 MCP Server 列表
    ```json
    {
      "servers": {
        "filesystem": { "command": "npx", "args": ["-y", "@anthropic/mcp-filesystem"] },
        "github": { "command": "npx", "args": ["-y", "@anthropic/mcp-github"], "env": { "GITHUB_TOKEN": "..." } },
        "postgres": { "command": "npx", "args": ["-y", "@anthropic/mcp-postgres", "postgresql://..."] }
      }
    }
    ```
  - 前端 MCP 管理面板：添加 / 移除 / 启停 MCP Server，查看连接状态和可用工具列表
  - 支持从 MCP Server 市场一键安装（类似插件商店）

- **可接入的 MCP Server 示例**：
  - **文件系统** — 安全的文件读写操作（替代自建的文件工具，获得标准化实现）
  - **GitHub** — 读取仓库、创建 PR、管理 Issue
  - **数据库** — 直连 PostgreSQL / MySQL，执行查询和数据分析
  - **Notion** — 读写 Notion 页面和数据库（替代直接调 Notion API）
  - **Slack / 飞书** — 发送消息、读取频道内容
  - **浏览器** — Puppeteer / Playwright 控制浏览器（网页抓取、自动化测试）
  - **Google Drive / Calendar** — 文档管理和日程操作
  - **自定义 MCP Server** — 用户可为自己的内部系统编写 MCP Server 接入

- **与内置工具的关系**：
  - Phase 2.2 / 2.3 的文件操作和终端命令是内置工具，保证开箱即用
  - MCP 是扩展机制 — 当社区有更好的 MCP Server 实现时，可替代内置工具
  - 两者在 Tool Registry 中统一管理，Agent 无需区分工具来源

- **安全机制**：
  - MCP Server 权限分级：只读 / 读写 / 完全控制
  - 敏感操作（写入、删除、发送消息）需用户确认
  - MCP Server 运行在独立进程，崩溃不影响主服务
  - 审计日志：记录所有 MCP 工具调用历史

### 2.8 工具组装应用场景
> 把工具组合起来，形成可复用的 Agent 应用模式。

- 代码分析 Agent：读取项目结构 → 分析代码 → 输出报告
- Research Agent：联网搜索 → 聚合多源信息 → 生成结构化摘要
- Vibe Coding：用户描述需求 → Agent 自主编写代码 → 运行验证 → 迭代修改

### 2.9 工具 Profile 过滤与延迟加载
> 工具太多模型选不准的解法。

- 工具 Profile 分组：按场景（编码 / 搜索 / 文件管理）分组
- 根据用户意图动态加载相关工具子集，避免一次性注入全部工具描述
- 工具优先级排序：高频工具优先、低频工具延迟加载
- 减少 token 消耗，提升模型工具选择准确率

---

## Phase 3 — 工具生态扩展

在 Agent 架构 + MCP 协议之上，接入更多工具能力。

### 3.1 Skill 技能系统 — 给 Agent 注入领域知识
- 可扩展的技能插件架构，每个 Skill = 一组 Tool + 专属 system prompt + 领域知识
- 内置技能：
  - `/translate` — 快速翻译（自动检测语言）
  - `/summarize` — 对当前对话 / 粘贴的长文做摘要
  - `/code-review` — 粘贴代码或指定文件，获取审查建议
  - `/search` — 联网搜索并整合结果（调用搜索引擎 API）
  - `/todo` — 管理个人待办事项（CRUD + 持久化）
  - `/memo` — 快速记录备忘，存入知识库
- 用户通过 `/` 前缀触发，输入框支持自动补全和参数提示
- Skill 注册机制：标准化的 manifest 文件，支持用户自定义技能
- Skill 可组合：一个 Skill 的输出可作为另一个的输入（管道模式）

### 3.2 Plugin 架构 — 让别人给你的 Agent 写功能
- 标准化 Plugin manifest（name、tools、prompts、permissions）
- Plugin 注册 / 安装 / 卸载机制
- Plugin 市场 / 目录：浏览、搜索、一键安装社区插件
- Plugin 沙箱隔离：插件运行在独立环境，崩溃不影响主服务
- 开发者文档 + Plugin 模板，降低开发门槛

### 3.3 Channel 抽象 — 让 Agent 活在飞书群里
- Channel 接口抽象：统一的消息输入/输出协议
- 内置 Channel：Web UI（当前）、飞书群机器人、微信/企微、Slack、Telegram、API 接口
- 每个 Channel 独立适配消息格式（Markdown / 富文本 / 卡片）
- 跨 Channel 共享同一个 Agent 实例（记忆、工具、知识库统一）

### 3.4 定时任务与自动化
- 用户可通过对话创建定时任务（如"每天早上 9 点给我发今日待办摘要"）
- 后端调度引擎（node-cron / BullMQ）
- 任务类型：
  - 定时知识库同步（Notion / 语雀 / GitHub 等数据源）
  - 定时摘要推送（邮件 / Webhook）
  - 定时执行脚本（数据备份、报表生成等）
  - 定时提醒（日程、DDL、习惯打卡等）
- 定时任务本身也通过 Tool 实现：
  - `create_cron_job` — 创建定时任务
  - `list_cron_jobs` — 查看所有任务
  - `delete_cron_job` — 删除任务
- 任务管理面板：状态、历史执行记录、手动触发 / 暂停 / 删除
- 任务执行结果自动写入对话历史

### 3.5 文件上传与解析
- 支持上传 PDF / Word / TXT / Markdown / 图片文件
- 服务端解析后注入对话上下文
- 结合 Agent 能力：上传代码文件后可自动分析、重构、生成测试

### 3.6 联网搜索
- 集成搜索引擎 API（Tavily / SearXNG / Bing）
- 作为 Tool 注册，模型自主决定何时需要搜索
- 搜索结果结构化展示（来源、摘要、链接）

---

## Phase 4 — 知识管理体系

围绕个人知识库构建系统化的管理能力。

### 4.1 Notion 自动同步
- 定时任务自动拉取 Notion 更新内容（复用 Phase 3 的定时任务能力）
- 增量同步：只处理变更的页面，避免全量重建
- 同步状态仪表盘：已同步页面数、最后同步时间、失败记录

### 4.2 知识库管理界面
- 可视化展示已入库的文档列表
- 支持手动上传文档到知识库
- 按标签 / 来源筛选和搜索已有文档
- 一键删除 / 重新索引指定文档

### 4.3 多数据源接入
- 支持从 GitHub Repo、Yuque（语雀）、飞书文档等导入
- 支持网页 URL 抓取并入库
- 统一的数据源管理面板

---

## Phase 5 — Context Engineering + 高级交互

### 5.1 Microcompact + LLM 摘要压缩
- 对话太长时自动触发摘要压缩，保留关键信息，压缩冗余
- 用小模型做摘要，降低成本
- 压缩后的摘要作为上下文前缀，保持对话连贯性

### 5.2 三层即时防线 — Token 估算、工具截断与 TTL 修剪
- Token 估算：发送前预估 token 数，超限时主动压缩
- 工具结果截断：工具输出过长时自动截取关键部分
- TTL 修剪：旧消息按时间衰减，超过 TTL 的消息自动移除或压缩

### 5.3 Prompt Cache 与成本追踪
- 接入 Anthropic Prompt Cache，缓存 system prompt 等静态内容
- 成本追踪面板：每次对话的 token 消耗、缓存命中率、费用估算

### 5.4 多轮对话优化
- 对话分支：从某条消息处创建分支，探索不同回答方向
- 相关问题推荐：回答结束后推荐后续问题

### 5.5 搜索与回顾
- 全局搜索：跨所有会话搜索历史消息
- 对话收藏 / 置顶
- 按日期、关键词筛选历史对话

### 5.6 System Prompt 管理
- 提供 UI 面板，让用户自定义系统提示词
- 预设多种角色模板（翻译助手、代码顾问、写作教练等）
- 每个会话可独立设置不同的 system prompt

### 5.7 语音交互
- 语音输入：集成 Web Speech API 或 Whisper
- 语音播报：TTS 朗读助手回复

---

## Phase 6 — 工程化与部署

### 6.1 权限系统 + Hook 管线
- 用户认证：Supabase Auth / NextAuth.js（邮箱 / GitHub / 微信）
- 用户数据隔离
- 权限分级：工具级（哪些可用）、文件级（目录白名单）、操作级（只读/读写/管理员）
- Hook 管线：工具执行前后的 Hook（pre-execute / post-execute），可用于审计日志、权限检查、结果过滤

### 6.2 用量控制
- Token 消耗统计与可视化
- 请求频率限制
- API Key 管理界面

### 6.3 响应式适配
- 移动端适配：侧边栏抽屉化、底部输入栏优化
- PWA 支持
- 深色 / 浅色主题切换

### 6.4 Sub-Agent 与 Evaluator 验收
- 复杂任务拆分为多个子 Agent 并行执行（Planner / Worker / Reviewer）
- Evaluator 验收：任务完成后自动运行验收检查，失败则回传修复
- Agent 间通信：共享上下文、传递中间结果
- 前端多 Agent 执行进度可视化

### 6.5 多模型路由 + Config 系统
- 智能路由：根据任务类型自动选择模型（简单问答 → 小模型，复杂推理 → 大模型）
- Fallback：主模型不可用时自动切换备用
- 统一 Config 管理：模型/工具/MCP/权限/记忆策略，分层（全局 → 用户 → 会话），热更新
- 前端设置面板：可视化管理所有配置项

### 6.6 部署与运维
- Docker 容器化部署方案
- Vercel / 自托管部署文档
- 错误监控（Sentry）
- CI/CD 流水线

---

## 优先级总览

| 优先级 | 功能 | 理由 |
|--------|------|------|
| **P0** | **Agent Harness 运行时外壳** | 整个 Agent 的容器，所有模块挂载于此 |
| **P0** | **Tool Use 工具调用引擎** | Agent 架构的地基，所有后续能力依赖此 |
| **P0** | **Agentic Loop 自主多步执行** | Agent 的核心循环，有了它才能"自主干活" |
| **P0** | RAG 知识库问答 | 核心差异化能力，Supabase 基础已就绪 |
| **P0** | 对话持久化 | 基本可用性保障 |
| **P1** | **文件系统操作工具** | Agent 最常用的工具，读写文件是基本功 |
| **P1** | **终端命令执行工具** | 让 Agent 能跑代码、跑脚本、跑测试 |
| **P1** | **规划与反思能力** | 复杂任务的可靠性保障 |
| **P1** | **记忆系统** | 跨会话记住用户偏好和项目上下文，越用越懂你 |
| **P1** | **MCP 协议支持** | 标准化扩展接口，即插即用接入海量外部工具 |
| **P1** | 输入体验升级 | 低成本高收益 |
| **P1** | Markdown 渲染增强 | 代码复制等高频需求 |
| **P2** | Skill 技能系统 | 高频操作快捷化，扩展性基石 |
| **P2** | Plugin 开放架构 | 让社区给 Agent 写功能 |
| **P2** | 定时任务与自动化 | 被动问答升级为主动服务 |
| **P2** | Context Engineering（压缩/缓存/成本） | 长对话质量与成本的平衡 |
| **P2** | 工具 Profile 过滤 | 工具多了之后的必需品 |
| **P2** | 文件上传与解析 | 扩展输入方式 |
| **P2** | 联网搜索 | 突破模型知识截止限制 |
| **P3** | Channel（飞书/微信/Slack） | 让 Agent 无处不在 |
| **P3** | 权限 + Hook 管线 | 多用户安全保障 |
| **P3** | Sub-Agent + Evaluator | 复杂任务终极方案 |
| **P3** | 多模型路由 + Config 系统 | 生产化基础 |
| **P3** | 知识管理体系 | 系统化知识管理 |
| **P3** | 高级交互 | 体验锦上添花 |
| **P4** | 部署与运维 | 按需推进 |

---

## 技术架构参考

```
用户输入（Web / 飞书 / Slack / API）
  │
  ▼
┌──────────────────────────────────────────┐
│  Channel 层（消息适配）                    │
└──────────────┬───────────────────────────┘
               ▼
┌──────────────────────────────────────────┐
│  Agent Harness (运行时外壳)               │
│  权限检查 / Hook 管线 / 沙箱隔离          │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  Agent Loop Engine                 │  │
│  │                                    │  │
│  │  Prompt Pipe:                      │  │
│  │  system + memory + RAG + tools     │  │
│  │           │                        │  │
│  │  while (stop_reason!='end_turn'):  │  │
│  │    ├─ LLM 推理 (多模型路由)        │  │
│  │    ├─ 解析 tool_use                │  │
│  │    ├─ 执行 Tool (截断 / 并发)      │  │
│  │    └─ 回传 tool_result             │  │
│  │           │                        │  │
│  │  鲁棒性: 循环检测/容错/Token 预算  │  │
│  │  上下文: 压缩 / TTL 修剪 / Cache   │  │
│  └────────────────────────────────────┘  │
└──────────────┬───────────────────────────┘
               ▼
┌──────────────────────────────────────────┐
│  Tool Registry (Profile 过滤 + 延迟加载) │
│                                          │
│  内置: file / bash / RAG / memory / cron │
│  MCP:  github / postgres / notion / ...  │
│  Plugin: 社区插件 / 用户自定义            │
└──────────────┬───────────────────────────┘
               ▼
┌──────────────────────────────────────────┐
│  持久层 (Supabase)                        │
│  sessions / messages / memories          │
│  documents (RAG) / cron_jobs / config    │
└──────────────────────────────────────────┘
               ▼
  流式响应 → 前端渲染（文本 / 工具卡片 / diff / 终端 / 记忆标记）
```
