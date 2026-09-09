# 个人知识助手

这是一个面向个人使用的智能助手项目。系统以 Next.js 为 Web 与 API 入口，在同一仓库中实现流式对话、工具调用、长期记忆、Agentic RAG、定时任务、用量统计和链路追踪；需要执行不可信命令时，可接入独立的 Go Sandbox Broker。

项目目前采用“单仓库、分层模块、按安全边界拆服务”的结构：大部分业务运行在 Next.js 进程中，浏览器代码、应用用例、传输协议和基础设施适配器保持明确的依赖方向，沙箱执行则独立部署。

## 已实现能力

- **多模型对话**：支持用户级 Provider、模型发现、默认模型和工具开关，聊天响应采用流式事件协议。
- **上下文与记忆**：包含会话记忆、长期事实、语义记忆、关键词召回、冲突治理、历史版本和上下文预算。
- **知识库与 RAG**：支持 Notion 接入、异步摄取、文本切块、向量与关键词混合检索、重排、证据评分和 Wiki 编译。
- **Agent 工具**：内置时间、计算器、联网搜索、知识检索、待办、LeetCode、记忆召回、定时任务和沙箱技能等工具。
- **执行策略**：支持自动规划、计划审核、工具确认、预算限制、上下文压缩和产物管理。
- **任务调度**：支持 Cron/周期任务、运行记录和通知渠道；生产环境由外部定时器触发 tick。
- **可观测性**：记录 Trace、Token 用量、模型费用和在线评分，并可按用户接入 Langfuse。
- **用户数据边界**：使用 Supabase Auth 和显式 `user_id` 过滤隔离业务数据；用户级凭据加密保存，配置表、沙箱表等已启用 RLS。
- **安全沙箱（可选）**：Go Broker/Worker 通过容器运行技能，提供 HMAC 鉴权、幂等、租约、取消、资源限制和产物存储。

侧边栏中的 **MCP** 和“英语、围棋、金融、编码、研报”等定制助手当前是预留入口，尚未接入完整业务实现。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| Web | Next.js 14 App Router、React 18、TypeScript、Tailwind CSS |
| Agent | Vercel AI SDK、OpenAI 兼容接口、Anthropic SDK、自研 Runtime 与工具协议 |
| 数据 | Supabase（PostgreSQL、Auth、Storage、pgvector）、Redis |
| 知识集成 | Notion API、向量嵌入、Tavily / Exa / Brave Search |
| 可观测性 | OpenTelemetry、Langfuse |
| 沙箱 | Go 1.26、PostgreSQL、rootless Podman 或开发环境 Docker |
| 质量保障 | Vitest、ESLint、TypeScript、Go test / race / vet、架构边界检查 |

## 代码结构

```text
.
├─ app/                         Next.js 页面、登录页和 API Route 适配器
├─ apps/
│  ├─ web/                     浏览器组件、Hooks、页面状态和认证客户端
│  └─ sandbox-broker/          独立的 Go Broker/Worker 沙箱服务
├─ packages/
│  ├─ contracts/               跨端 DTO、事件协议和纯序列化逻辑
│  ├─ application/             应用用例、流程编排和 Ports
│  └─ infrastructure/          数据库、缓存、遥测等 Ports 的实现
├─ lib/
│  ├─ agent/                   Runtime、工具、RAG、记忆、上下文、评估
│  ├─ knowledge/               Notion 同步、切块、嵌入、检索和摄取队列
│  ├─ scheduler/               定时任务、领取执行和通知投递
│  ├─ llm|search|langfuse/     用户级外部服务配置与连接适配
│  └─ platform/                Supabase、Redis 和公共平台能力
├─ scripts/                     Worker、清理任务、评估和运维脚本
├─ docs/                        架构、数据库、Agent 与 RAG 专题文档
├─ deploy/                      Nginx 与 systemd 部署配置
├─ docker-compose.dev.yml       本地 Redis
└─ docker-compose.yml           生产 Web + Redis 编排
```

### 模块依赖方向

```text
app（页面与 Route）
├──> apps/web ─────────────────────> packages/contracts
├──> packages/application ─────────> packages/contracts
└──> packages/infrastructure ──────> lib 中尚未迁移的实现
```

- `contracts` 不依赖框架、环境变量或 I/O。
- `application` 只负责编排，通过 Port 描述外部依赖。
- `infrastructure` 实现 Port，并连接 Supabase、Redis、Langfuse 等服务。
- `apps/web` 只放浏览器侧代码，通过 API 使用服务端能力。
- `app` 保持为轻量的 Next.js 路由与页面适配层。
- `lib` 保存现有 Agent Runtime 和领域实现，后续逐步迁移到边界清晰的 package。

运行 `npm run check:architecture` 可以检查反向依赖、非法跨层导入和过度膨胀的聊天 Route。完整规则见 [模块边界说明](docs/architecture/module-boundaries.md)。

## 本地运行

### 1. 环境要求

- Node.js 20+
- npm（项目使用 `package-lock.json`）
- Docker 与 Docker Compose（用于本地 Redis）
- 一个 Supabase 项目，并启用 Email/Password 登录
- Go 1.26（仅开发 Sandbox Broker 时需要）

### 2. 安装依赖

```bash
npm install
```

### 3. 初始化 Supabase

数据库脚本位于 `docs/schemas/`：

- 基础能力分别由 `database-schema.sql`、`sessions-schema.sql`、`memories-schema.sql`、`semantic-memories-schema.sql`、`scheduled-jobs-schema.sql` 和 `traces-schema.sql` 提供。
- 后续变更按日期保存在 `docs/schemas/migrations/`。
- 多模态聊天还需要迁移创建私有的 `chat-images` Storage Bucket。

新环境请先阅读 [数据库初始化指南](docs/database/database-setup-guide.md) 和 [生产部署说明](DEPLOY.md)，再按功能执行基础 Schema 与增量迁移。不要在已有数据的环境中执行 `database-schema-clean.sql`，该脚本会删除并重建 RAG 表。

### 4. 配置环境变量

在根目录创建 `.env.local`：

```dotenv
# 必需：Supabase Auth、数据库与 Storage
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# 必需：本地会话与缓存
REDIS_URL=redis://127.0.0.1:6379
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# 使用界面保存 Provider、Notion、Embedding、搜索或 Langfuse 密钥时必需
# 值必须是 32 字节内容的 Base64 编码，可用 `openssl rand -base64 32` 生成
CONFIG_ENCRYPTION_KEY=your_base64_key

# 可选：允许编辑服务端运行时配置的登录邮箱，多个邮箱用逗号分隔
CONFIG_ADMIN_EMAILS=you@example.com

# 可选：启用定时任务 tick 时配置
CRON_SECRET=replace_with_a_random_secret
```

模型、Embedding、搜索引擎、Notion 和 Langfuse 凭据主要由登录用户在“连接”页面配置，并使用 `CONFIG_ENCRYPTION_KEY` 加密保存，不需要把模型 API Key 写入仓库。生产环境变量模板及高级配置见 [.env.production.example](.env.production.example)。

### 5. 启动 Redis 与 Web

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec redis redis-cli ping
npm run dev
```

Redis 返回 `PONG` 后，访问 [http://localhost:3000](http://localhost:3000)。首次使用时注册或登录账户，然后至少在“连接 → 大语言模型”中配置一个启用模型；知识库与语义记忆还需要配置兼容的 1024 维 Embedding 模型。

停止本地 Redis：

```bash
docker compose -f docker-compose.dev.yml down
```

## 可选：运行 Sandbox Broker

Sandbox Broker 是独立服务，不会被 Next.js 自动启动。仅调试 Broker API 时可使用内存存储并关闭本地鉴权：

```powershell
$env:SANDBOX_BROKER_AUTH_DISABLED = "true"
npm run sandbox:dev
```

默认监听 `127.0.0.1:8081`。生产环境必须使用 PostgreSQL 存储、HMAC 鉴权和独立 Worker，且不允许把 Docker/Podman Socket 挂载给 Next.js 容器。具体配置见 [Sandbox Broker 说明](apps/sandbox-broker/README.md) 和 [远程部署指南](apps/sandbox-broker/docs/remote-deployment.md)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run build` / `npm run start` | 构建并运行生产版本 |
| `npm run lint` | 执行 Next.js ESLint 检查 |
| `npm run typecheck` | 检查根项目 TypeScript 类型 |
| `npm run typecheck:packages` | 检查三个 workspace package |
| `npm run check` | 执行架构检查与全部 TypeScript 类型检查 |
| `npm test` | 运行 Vitest 测试 |
| `npm run test:eval` | 运行 Agent 评估测试 |
| `npm run rag:sync` / `npm run rag:search` | 同步或检索知识库 |
| `npm run rag:ingestion:work` | 启动 RAG 摄取 Worker |
| `npm run scheduler:dev` | 启动本地定时任务触发器 |
| `npm run sandbox:test` | 运行 Go 沙箱测试 |
| `npm run sandbox:race` / `npm run sandbox:vet` | 执行 Go 竞态检测与静态检查 |

## 部署与文档

- [生产环境部署](DEPLOY.md)：Docker Compose、Nginx、HTTPS、密钥与 systemd 定时器。
- [项目文档入口](docs/README.md)：推荐阅读顺序与文档维护规则。
- [文档分类索引](docs/docs-catalog.md)：按架构、Runtime、RAG、记忆、调度和可观测性分类。
- [Agentic RAG 实现](docs/rag/agentic-rag-production.md)：检索链路、治理与生产边界。
- [结构化执行策略](docs/agent/runtime/execution-strategy.md)：计划、审核、工具授权与执行控制。
- [分层记忆架构](docs/agent/memory/layered-memory.md)：会话、长期与语义记忆的职责。

生产部署使用根目录 `Dockerfile` 和 `docker-compose.yml`。Web 仅绑定宿主机 `127.0.0.1:3000`，Redis 只位于 Compose 私有网络；公网流量应统一经过 Nginx 的 80/443 端口。
