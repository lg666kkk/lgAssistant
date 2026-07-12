# LG 个人知识助手 - 简化路线图

> 目标：先做出一个稳定、可持续迭代的个人知识助手，再逐步演进为具备工具调用和 Agent 能力的系统。  
> 原则：每个阶段都必须交付一个可用版本，避免过早堆叠大抽象。

---

## 当前状态（2026-06-13 校准，对齐真实代码）

> ⚠️ 早期版本严重低估了进度。M0–M3、M5 大部分已经实现，详见 `TODO.md`「当前项目状态」。

已具备：
- Next.js 14 + TypeScript + Tailwind 基础应用
- 流式聊天 + 停止生成 + textarea 输入体验
- 多会话 + **Redis 持久化**（刷新/重启可恢复历史）
- 配置模块 + 模型选择（`lib/platform/config.ts`、`lib/agent/models.ts`）
- **RAG 全链路已打通并接入对话**（Notion → chunk → embedding → 检索，经 `search_notes` 工具）
- **Tool Use 引擎 + Tool Registry + Agentic Loop**（`lib/agent/runtime/`、`tools/`）
- **工具权限分级**（safe / confirm / dangerous）+ 审批路由
- **记忆系统**（session/semantic/longterm 三层 + recall/consolidate）
- **联网搜索**（Tavily `web_search` 工具）
- **可观测性**：Trace 链路 + Eval harness（`npm run test:eval`）

主要缺口（真正未做）：
- DB migration 未收口（schemas 散落，建表入口不全）
- 文件 / 终端工具尚未实现（权限框架已就绪，只缺工具本体）
- MCP 协议未接入
- 规划反思（Plan→Execute→Verify）、多 Agent 未做
- Markdown 增强（复制按钮 / 表格 / LaTeX）、会话标题重命名、RAG 引用前端展示
- 混合检索（向量 + BM25）未做

---

## M0 - 稳定聊天 MVP

目标：让当前聊天功能可靠、好用、可恢复。

### M0.1 配置整理
- 新增服务端配置读取模块
- 将模型名、baseURL、max_tokens 从路由中移出
- 缺少必要环境变量时返回明确错误
- 在 README 中补充必需环境变量

完成定义：
- `/api/chat` 不再硬编码模型配置
- 环境变量缺失时不会出现难以理解的 500 错误

### M0.2 API 错误处理
- 包裹 `req.json()` 解析错误
- 校验 `messages` 格式
- 捕获 LLM SDK 调用错误
- 流式过程中出错时返回结构化错误

完成定义：
- 非法请求返回 400
- 模型调用失败返回可展示的错误信息
- 前端不会因为后端异常卡在 loading 状态

### M0.3 输入框升级
- 将单行 input 改为 textarea
- Enter 发送
- Shift+Enter 换行
- 发送后清空并重新聚焦
- loading 时禁止重复发送

完成定义：
- 多行输入体验符合常见聊天产品习惯
- 连续发送不会产生重复请求

### M0.4 停止生成
- 前端增加“停止”按钮
- 暴露 activeSession 的 abort 能力
- 停止后保留已生成的部分内容
- 停止后恢复输入状态

完成定义：
- 用户可以中断正在生成的回复
- 中断后可以继续发送下一条消息

### M0.5 会话数据模型
- 设计 `sessions` 表
- 设计 `messages` 表
- 明确字段：
  - session id
  - title
  - role
  - content
  - created_at
  - updated_at
- 准备 Supabase SQL migration 或建表说明

完成定义：
- 数据结构能支持当前多会话 UI
- 后续 RAG、记忆、工具消息可以继续扩展

### M0.6 会话持久化
- 页面加载时读取会话列表
- 切换会话时读取消息
- 发送用户消息后写入数据库
- assistant 流式完成后写入最终回复
- 删除会话时同步删除消息

完成定义：
- 刷新页面后历史会话仍在
- 删除会话后数据库中没有孤儿消息

### M0.7 会话标题
- 首条用户消息自动生成默认标题
- 支持手动重命名
- 标题更新写入数据库

完成定义：
- 会话列表可读性明显改善
- 刷新后标题保持不变

### M0.8 基础质量检查
- 修复当前 React Hook lint warning
- 跑通 `npm run lint`
- 跑通 `npm run build`

完成定义：
- lint 和 build 均通过
- 没有新增 TypeScript 错误

---

## M1 - 最小 RAG 知识库问答

目标：让助手能基于个人知识库回答问题，并给出来源。

### M1.1 文档表结构确认
- 确认 `documents` 表字段
- 确认 pgvector 扩展可用
- 确认 `match_documents` RPC 函数
- 补充建表 SQL 或 migration 文档

完成定义：
- 可以手动插入一条带 embedding 的文档 chunk
- 可以通过 RPC 返回相似结果

### M1.2 Notion 读取
- 配置 Notion API key
- 配置允许同步的页面或数据库
- 实现读取页面标题、正文、链接、更新时间
- 处理空页面和不支持的 block 类型

完成定义：
- 可以从指定 Notion 页面拿到纯文本内容
- 每个页面保留可引用的标题和 URL

### M1.3 Chunking
- 按字符数或 token 近似长度切块
- chunk 保留 page_id、page_title、url、chunk_index
- 控制 chunk 重叠长度
- 过滤过短内容

完成定义：
- 同一页面可以稳定切成多个 chunk
- chunk metadata 足够生成引用来源

### M1.4 Embedding
- 选择 embedding 模型
- 封装 embedding client
- 批量生成 embedding
- 处理 embedding API 错误和重试

完成定义：
- 给定文本数组可以返回向量数组
- 失败时不会写入半成品数据

### M1.5 手动同步命令或 API
- 实现手动同步入口
- 同步前删除该页面旧 chunk
- 写入新 chunk
- 输出同步结果：
  - 页面数
  - chunk 数
  - 成功数
  - 失败原因

完成定义：
- 可以重复同步同一页面且不产生重复数据
- 同步失败时能定位是哪一页失败

### M1.6 检索接口
- 根据用户问题生成 query embedding
- 调用 `searchDocuments`
- 设置最小相似度阈值
- 限制返回数量
- 返回内容、标题、URL、相似度

完成定义：
- 给定问题可以返回相关 chunk
- 无结果时返回空数组而不是报错

### M1.7 RAG 注入聊天
- 在聊天 API 中先执行检索
- 将检索结果组装成上下文
- 注入 system prompt 或专门的 context block
- 要求模型基于来源回答
- 无来源时允许普通回答

完成定义：
- 知识库相关问题优先使用检索结果
- 非知识库问题不被强行套用 RAG

### M1.8 引用展示
- 回答中包含来源标题
- 前端正确渲染链接
- 保留引用和回答之间的可读结构

完成定义：
- 用户能从回答跳转到对应 Notion 页面
- 至少一个命中来源能被展示出来

### 暂不做
- 自动定时同步
- 多数据源接入
- BM25 + 向量混合检索
- 知识库管理后台

### 整体验收标准
- 指定一批 Notion 页面后可以完成入库
- 提问时能命中相关知识片段
- 回答能引用至少一个来源
- 无检索结果时能正常退化为普通聊天

---

## M2 - Prompt Pipe 与服务端结构整理

目标：把聊天请求从单一 API 处理函数，整理成可扩展的后端流程。

### M2.1 目录结构调整
- 新增 `lib/knowledge` 或类似领域服务目录
- 区分 client-safe 代码和 server-only 代码
- 避免 service role key 被前端误引用

完成定义：
- Supabase service role client 只在服务端模块中出现
- 前端 import 不会触碰服务端密钥模块

### M2.2 类型统一
- 定义应用内部消息类型
- 定义 LLM 消息转换函数
- 为后续 tool message 预留类型
- 为引用来源定义类型

完成定义：
- 前端消息、数据库消息、LLM 消息之间有明确转换边界

### M2.3 LLM Client 封装
- 封装普通文本流式调用
- 封装错误格式
- 封装模型配置
- 保留后续 tool use 参数入口

完成定义：
- `/api/chat` 不直接调用 Anthropic SDK 细节

### M2.4 Prompt Pipe
- 定义 `buildPrompt` 或等价函数
- 输入：
  - system prompt
  - 历史消息
  - RAG context
  - user message
- 输出模型可直接消费的 messages
- 控制上下文长度

完成定义：
- Prompt 组装逻辑可单独测试
- 增加或移除 RAG 不影响路由主流程

### M2.5 Streaming 协议预留
- 从纯文本流演进到 JSON line 或 SSE
- 事件类型至少预留：
  - `text_delta`
  - `error`
  - `done`
  - `source`
  - `tool_call`
  - `tool_result`
- 前端按事件类型渲染

完成定义：
- 当前文本流仍可正常显示
- 后续工具调用不需要再次替换底层协议

### 整体验收标准
- `/api/chat` 只负责请求入口和响应输出
- RAG、system prompt、历史消息的组装逻辑不散落在路由里
- 后续加入 Tool Use 时不需要重写整个聊天链路

---

## M3 - 最小 Tool Use + Agent Loop

目标：让助手从“只回答文本”升级为“能调用少量安全工具”。

### M3.1 Tool 接口
- 定义工具名称、描述、输入 schema、输出类型
- 定义工具错误格式
- 定义工具执行上下文

完成定义：
- 新增一个工具时不需要改 Agent Loop 核心逻辑

### M3.2 Tool Registry
- 注册工具
- 按名称查找工具
- 输出模型可用的 tool schema
- 支持启用 / 禁用工具

完成定义：
- 当前请求可以决定暴露哪些工具给模型

### M3.3 第一批只读工具
- `search_documents`
- `get_current_session`
- `list_recent_sessions`

完成定义：
- 所有工具只读
- 工具输出长度有上限

### M3.4 Tool Use 模型调用
- 调整 LLM Client，支持传入 tools
- 解析模型返回的 tool use block
- 将工具结果转换为模型可继续消费的消息

完成定义：
- 模型可以提出工具调用
- 后端可以执行并回传工具结果

### M3.5 Agent Loop
- 循环调用模型
- 遇到 tool use 时执行工具
- 遇到最终文本时结束
- 设置最大轮数
- 设置单次请求超时

完成定义：
- 一次用户请求可以完成至少一轮工具调用再回答
- 循环超限时能停止并提示用户

### M3.6 前端工具展示
- 展示工具名称
- 展示工具参数摘要
- 展示工具执行状态
- 展示工具结果摘要
- 错误状态可见

完成定义：
- 用户能看懂助手为什么使用了某个工具

### 暂不做
- 文件写入
- 终端命令执行
- MCP
- 多 Agent

### 整体验收标准
- 模型能根据用户问题主动调用 `search_documents`
- 一次请求中可以完成“检索 -> 回答”
- 工具调用过程在前端可见
- 循环超限时能停止并提示用户

---

## M4 - 高风险工具与权限边界

目标：在有清晰权限模型后，再让助手操作文件和命令。

### M4.1 权限模型
- 工具级权限
- 文件目录白名单
- 只读 / 读写操作区分
- 敏感文件规则
- 命令 allowlist / denylist

完成定义：
- 每个工具执行前都经过权限检查

### M4.2 审批流
- 前端展示待审批操作
- 用户可以 approve / deny
- 后端等待审批结果
- 审批结果写入日志

完成定义：
- 写操作和命令执行不能绕过用户确认

### M4.3 文件只读工具
- `list_directory`
- `read_file`
- `search_files`
- 行数和输出长度限制

完成定义：
- 默认只能读白名单目录
- `.env` 等敏感文件不可读

### M4.4 文件编辑工具
- `edit_file`
- 基于 search / replace
- 编辑前生成 diff
- 用户确认后写入
- 写入后读取文件确认结果

完成定义：
- 不做整文件盲目覆盖
- 用户能在确认前看到变更内容

### M4.5 终端工具
- `run_command`
- 工作目录限制
- 命令超时
- stdout / stderr 流式输出
- 输出长度截断
- exit code 展示

完成定义：
- 长时间命令不会无限挂起
- 高风险命令会被拦截或要求确认

### M4.6 审计日志
- 记录工具名
- 记录参数摘要
- 记录审批结果
- 记录执行结果
- 记录耗时和错误

完成定义：
- 可以追踪一次 Agent 操作到底做了什么

### 整体验收标准
- 默认不能读取白名单以外路径
- 默认不能读取 `.env` 等敏感文件
- 写操作必须经过用户确认
- 命令执行有超时和输出截断
- 所有工具调用有日志记录

---

## M5 - 记忆与自动化

目标：让助手跨会话积累偏好和项目上下文，并能做简单主动任务。

### M5.1 记忆表结构
- 设计 `memories` 表
- 字段包含：
  - id
  - type
  - content
  - metadata
  - embedding
  - created_at
  - updated_at

完成定义：
- 可以保存、查询、删除一条记忆

### M5.2 显式记忆
- 识别“记住...”类用户输入
- 保存为 memory
- 返回保存成功提示
- 支持“忘掉...”删除相关记忆

完成定义：
- 用户明确要求保存的信息能跨会话保留

### M5.3 记忆检索
- 为记忆生成 embedding
- 根据当前用户问题检索相关记忆
- 注入 Prompt Pipe
- 控制注入数量

完成定义：
- 新会话能使用历史保存的相关偏好或事实

### M5.4 记忆管理 UI
- 查看记忆列表
- 按类型筛选
- 删除记忆
- 手动新增记忆

完成定义：
- 用户能控制助手记住了什么

### M5.5 基础定时任务
- 设计 `scheduled_jobs` 表
- 支持创建 / 暂停 / 删除任务
- 支持定时同步 Notion
- 支持定时生成摘要
- 记录执行结果

完成定义：
- 至少一种定时任务能自动运行并留下日志

### 暂不做
- 自动激进记忆提取
- 记忆冲突自动合并
- 复杂任务调度系统

### 整体验收标准
- 助手能记住用户明确要求保存的信息
- 新会话能召回相关记忆
- 用户能查看和删除记忆
- 定时任务有执行记录和失败信息

---

## M6 - MCP、插件与多 Agent

目标：在单 Agent 能力稳定后，再扩展生态和复杂协作。

### M6.1 MCP Client 原型
- 支持配置一个 MCP Server
- 拉取 server 暴露的 tools
- 转换为内部 Tool Registry 工具
- 执行 MCP tool

完成定义：
- 至少一个 MCP 工具能通过现有 Agent Loop 调用

### M6.2 MCP 权限整合
- MCP 工具继承现有权限模型
- 对 MCP 工具做只读 / 写入分级
- 敏感工具需要用户审批
- MCP 调用写入审计日志

完成定义：
- MCP 工具不能绕过 M4 的权限和审批

### M6.3 Skill / Plugin 草案
- 定义 manifest 字段
- 定义工具声明方式
- 定义 prompt 片段声明方式
- 定义权限声明方式

完成定义：
- 可以用一个本地 manifest 注册一组工具和提示词

### M6.4 多 Agent 受控原型
- 只选择一个场景验证
- Planner 输出任务计划
- Generator 执行计划
- Evaluator 验证结果
- Agent 之间通过文件或数据库传递状态

完成定义：
- 多 Agent 只用于一个明确场景
- 不做通用平台化

### 前置条件
- M3 的 Tool Registry 已稳定
- M4 的权限和审计已稳定
- M5 的持久化状态能力已稳定

### 整体验收标准
- 至少接入一个 MCP Server
- MCP 工具遵守现有权限模型
- 多 Agent 原型只处理单一受控场景，不做通用平台化

---

## 明确暂缓

以下能力不进入近期开发，避免路线发散：
- Plugin 市场
- 多 Channel：飞书 / 微信 / Slack / Telegram
- 大规模多 Agent 自动开发平台
- 复杂知识库管理后台
- 多模型智能路由
- 语音交互
- PWA
- 深色 / 浅色主题切换

---

## 推荐近期优先级

1. M0：稳定聊天 MVP
2. M1：最小 RAG
3. M2：Prompt Pipe
4. M3：最小 Tool Use

完成这四步后，项目会从“聊天原型”变成一个真正可用的个人知识助手，并且具备继续演进为 Agent 的结构基础。
