# LG 个人知识助手 - 待办列表

> 根据 ROADMAP.md 生成，按优先级排序  
> 完成一项就在前面打勾 ✅

---

## 当前项目状态

- ✅ 基础流式对话（Anthropic SDK + DeepSeek 模型）
- ✅ 多会话管理（内存存储，未持久化）
- ✅ Supabase 向量存储基础设施
- ✅ Markdown 渲染 + 代码高亮
- ✅ 输入框升级：textarea、Enter 发送、Shift+Enter 换行、发送后聚焦
- ✅ 停止生成：前端 abort、后端安全中断、部分回复落库
- ✅ 基础质量检查：TypeScript / lint / build 已跑通

---

## 暂缓 TODO

- [ ] **M0.5 数据库 migration / 建表说明**
  - 补齐 `sessions` / `messages` / `documents` 的 SQL migration 或建表文档
  - 确认 `messages.session_id` 外键开启 `ON DELETE CASCADE`

- [ ] **M0.7 会话标题手动重命名**
  - 会话列表支持进入编辑态
  - 标题修改后调用 `updateSessionTitle`
  - 刷新后标题保持不变

- [ ] **M0 Dev Server 缓存稳定性**
  - 排查 `.next/cache/webpack` 偶发 ENOENT
  - 必要时补充清理和重启说明

---

## Phase 1 - 核心体验完善

- [ ] **1.1 RAG 知识库问答**
  - 接入 Notion API，自动同步笔记内容并分块
  - 调用 Embedding 模型生成向量，写入 Supabase `documents` 表
  - 用户提问时先做向量检索，将相关文档片段注入 system prompt
  - 混合检索策略：向量相似度 + BM25 融合排序
  - 回答中标注引用来源（页面标题 + 链接）

- [ ] **1.2 对话持久化 + Prompt Pipe**
  - 会话列表和消息记录持久化到 Supabase（当前仅存于内存）
  - 刷新页面后恢复历史对话
  - 支持对话标题编辑和重命名
  - 模块化 Prompt 组装管道

- [ ] **1.3 输入体验升级**
  - 单行 `<input>` 替换为多行 `<textarea>`，支持 Shift+Enter 换行
  - 支持停止生成（前端调用 abort，后端中断流）
  - 消息发送后自动聚焦输入框

- [ ] **1.4 Markdown 渲染增强**
  - 代码块添加一键复制按钮
  - 支持表格、LaTeX 公式渲染
  - 支持图片 / 链接的正确展示

---

## Phase 2 - Agent 核心能力（重点）

### 2A. 单 Agent 基础能力（P0/P1 优先级）

- [ ] **2A.0 Agent Runtime - 运行时基础设施**
  - 生命周期管理：初始化 → Prompt 组装 → LLM 调用 → 工具执行 → 输出响应
  - Tool Registry：所有工具（内置 / MCP / Plugin）统一注册
  - 权限层：工具执行前的权限检查（白名单 / 审批 / 拦截）
  - Hook 管线：pre-execute / post-execute Hook，支持审计日志、结果过滤
  - 沙箱隔离：文件操作限定目录、命令执行资源限制
  - 上下文注入：system prompt + 记忆 + RAG 结果 + 工具描述按优先级拼装
  - 流式输出管道：统一协议推送 LLM 文本 + 工具调用过程

- [ ] **2A.1 Tool Use 工具调用引擎**
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

- [ ] **2A.4 Agentic Loop - 自主多步执行**
  - 实现 Agent Loop：while (stop_reason !== 'end_turn') { 思考 → 调工具 → 回传结果 }
  - 支持模型在一次用户请求中自主执行多步操作
  - 循环保护：最大迭代次数（如 20 轮），超出后暂停并询问用户
  - 死循环检测：连续相同工具调用自动识别并打断
  - Token 预算、工具并发执行、全过程流式展示、用户随时中断

- [ ] **2A.5 规划与反思能力（Plan → Execute → Verify）**
  - Planning 阶段：模型先输出执行计划，前端可视化 checklist
  - Execution 阶段：按计划逐步执行，遇到意外自动调整
  - Verification 阶段：执行完毕后自动验证结果，失败自动进入修复循环

- [ ] **2A.6 记忆系统**
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

- [ ] **3.6 联网搜索**
  - 集成搜索引擎 API（Tavily / SearXNG / Bing）
  - 作为 Tool 注册，模型自主决定何时需要搜索

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

## 优先级建议

**P0（最高优先级）**：
- Phase 2A.0 Agent Runtime
- Phase 2A.1 Tool Use 引擎
- Phase 2A.4 Agentic Loop
- Phase 1.1 RAG 知识库问答
- Phase 1.2 对话持久化

**P1（高优先级）**：
- Phase 2A.2 文件系统操作工具
- Phase 2A.3 终端命令执行工具
- Phase 2A.5 规划与反思能力
- Phase 2A.6 记忆系统
- Phase 2A.7 MCP 协议支持
- Phase 1.3 输入体验升级
- Phase 1.4 Markdown 渲染增强

**P2（中优先级）**：
- Phase 2A.8 工具组装应用场景
- Phase 2A.9 工具 Profile 过滤
- Phase 2B.1-2B.3 Harness 多 Agent 协作（核心部分）
- Phase 3.1 Skill 技能系统
- Phase 3.2 Plugin 架构
- Phase 3.4 定时任务与自动化
- Phase 5.1-5.2 Context Engineering
- Phase 3.5 文件上传与解析
- Phase 3.6 联网搜索

**P3（低优先级）**：
- Phase 2B.4-2B.5 Harness 可观测性与前端可视化
- Phase 3.3 Channel 抽象
- Phase 6.1 权限系统
- Phase 6.4 多模型路由
- Phase 4 知识管理体系
- Phase 5.3-5.5 高级交互
- Phase 6.5 部署与运维

---

**建议执行路径**：
1. Phase 1（核心体验）+ Phase 2A.0-2A.1（Runtime + Tool Use）
2. Phase 2A.2-2A.4（工具集 + Agentic Loop）
3. Phase 1.1（RAG）+ Phase 2A.5-2A.7（规划、记忆、MCP）
4. Phase 2A.8-2A.9 + Phase 2B（工具组装 + 多 Agent）
5. Phase 3-6（工具生态 + 工程化）
