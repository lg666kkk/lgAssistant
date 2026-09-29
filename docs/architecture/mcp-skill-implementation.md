# MCP 与 Skill 模块实现

> 历史记录：本文整体描述的是已移除的 Go Sandbox Broker / Worker 实现，不是当前运行路径。当前执行路径见 [E2B Skill Runtime](./e2b-skill-runtime.md)。

本文保留用于回顾旧实现。MCP 的当前操作说明见 [MCP 接入](../mcp.md)，Skill 的当前运行约定见 [E2B Skill Runtime](./e2b-skill-runtime.md)。

## 1. 总体关系

两类能力共用 `ToolDefinition -> ToolRegistry -> Agent Runtime -> Tool Router`：

```text
浏览器 -> POST /api/chat -> runChatUseCase
                            |-> createBuiltinToolRegistry
                            |     |-> list_skills / view_skill / run_skill
                            |-> ExternalToolsPort.open(userId)
                                  |-> 用户 MCP 配置 -> MCP SDK 连接与发现
                                  |-> 允许的远端工具 -> 本地 ToolDefinition
                            -> 路由与意图过滤 -> 模型工具 Schema
                            -> 模型返回 tool call -> Tool Router -> ToolDefinition.execute
                                                           |-> MCP callTool
                                                           |-> 数据库读取 Skill
                                                           |-> Sandbox Broker Skill Run
```

HTTP 入口 [`app/api/chat/route.ts`](../../app/api/chat/route.ts) 负责认证并注入依赖；组合点是 [`packages/application/src/chat/run-chat.ts`](../../packages/application/src/chat/run-chat.ts)。生产依赖在 [`packages/infrastructure/src/chat/index.ts`](../../packages/infrastructure/src/chat/index.ts) 中装配。注册表向模型只投影 `name`、`description` 和 `input_schema`；`riskLevel`、`runtime`、`outputPolicy` 与实际 `execute` 留在本地。模型 provider 通过 `streamText({ tools })` 提供 Schema，本身不执行工具。见 [`registry.ts`](../../lib/agent/tools/registry.ts)、[`model-provider.ts`](../../lib/agent/runtime/model-provider.ts)。

| 维度 | MCP | Skill |
|---|---|---|
| 能力来源 | 用户配置的远端 MCP 服务 | 共享 Skill 目录和已发布的沙盒版本 |
| Agent 可见工具 | 每个获准远端工具各对应一个 `mcp_...` 工具 | 固定三个内置工具：`list_skills`、`view_skill`、`run_skill` |
| 执行位置 | 远端 MCP 服务 | 读取说明在应用端；可执行版本在 Sandbox Broker/Worker |
| 隔离含义 | MCP 是协议，不提供沙盒 | 可执行版本由独立容器运行时隔离 |
| 身份范围 | MCP 配置和连接按登录用户隔离 | Skill 目录共享；Run 以登录用户身份提交和查询 |

## 2. MCP：配置与发现

### 2.1 页面、API、存储

[`mcp-center.tsx`](../../apps/web/features/connections/components/mcp-center.tsx) 提供添加、测试连接、选择工具、设置确认方式、启停、编辑和删除。对应 API：

| API | 用途 |
|---|---|
| `GET/POST /api/mcp/servers` | 列出本人的服务、保存新服务 |
| `PATCH/DELETE /api/mcp/servers/{id}` | 编辑或删除本人的服务 |
| `POST /api/mcp/discover` | 连接测试、发现工具，不保存配置 |

各路由先调用 `requireUser`，具体读写在 [`user-config.ts`](../../packages/infrastructure/src/mcp/user-config.ts)。[`20260913-user-mcp-servers.sql`](../schemas/migrations/20260913-user-mcp-servers.sql) 创建 `user_mcp_servers`，包含 `user_id`、URL、启用状态、加密 Token 和 JSONB 工具允许列表。查询显式按 `user_id` 过滤；表启用 RLS，浏览器角色没有表权限。列表只返回 `tokenConfigured`，不返回 Token 内容。

保存前会校验配置结构、工具名不重复、启用服务至少允许一个工具，以及最多 8 个服务、每个服务最多 32 个启用工具。端点要求公网 HTTPS，并通过 URL 安全检查；Token 使用现有运行配置加密服务处理。编辑时留空 Token 表示保留原值；更换 URL 必须重填或清除旧 Token，防止凭据被发送到新端点。工具设置 `approval: "always"` 默认需要确认；只有标记为 `"read-only"` 才映射为免确认读取。相关类型在 [`mcp.ts`](../../packages/contracts/src/mcp.ts)。

“测试连接并发现工具”调用 `connectMcpServer`，读取远端工具名称与描述，保留已有工具的启用/确认设置，供用户选择后保存。测试连接只证明该次握手和发现成功，不证明之后调用一定成功。

### 2.2 聊天请求中的连接生命周期

`runChatUseCase` 为支持工具的模型打开 [`ExternalToolsPort`](../../packages/application/src/mcp/ports.ts) 会话。`createManagedMcpToolsPort` 读取当前用户已启用且至少有一个获准工具的服务，分别连接；单个服务失败只令该服务本轮不可用，其他服务和内置工具继续可用。配置下一轮聊天重新读取，不热更新正在执行的会话。

[`client.ts`](../../packages/infrastructure/src/mcp/client.ts) 使用 `@modelcontextprotocol/sdk` 的 `Client` 与 `StreamableHTTPClientTransport`，携带可选 Bearer Token。连接/发现受 10 秒初始化时限约束，最多遍历 20 页工具列表；禁用重试及 HTTP 重定向，网络请求还经过公网 URL 安全包装。发现结果只用于与已保存的工具允许列表匹配；获准工具缺失、Schema 过大或无法编译时，该服务本轮初始化失败。请求正常结束、取消和异常时会关闭客户端；有状态会话在正常关闭时尽力发送 DELETE。

上下文预览使用同一发现路径以估算工具 Schema 的 token 占用，结束后关闭连接，不调用远端工具。见 [`preview-context.ts`](../../packages/application/src/chat/preview-context.ts) 与 [`session.ts`](../../packages/application/src/mcp/session.ts)。

### 2.3 远端工具适配与执行

[`mcp-adapter.ts`](../../lib/agent/tools/mcp-adapter.ts) 为每个获准工具构造 `ToolDefinition`：

1. 由服务 ID、远端名称生成带 SHA-256 后缀的稳定本地名称 `mcp_...`，避免常见重名和特殊字符问题。
2. 保留远端参数 JSON Schema，并用 AJV 编译；调用前再次校验参数和当前 `userId`。
3. 写入或外部操作强制为 `confirm`；只读工具按用户设置决定是否免确认。设置超时、调用频率限制及服务级并发组；`sandboxed` 为 `false`。
4. 执行时通过 MCP SDK `callTool` 传回远端原始工具名，不自动重试。`isError: true` 转为工具失败。
5. 文本与 `structuredContent` 转为 `ToolResult`，模型可见文本最多 16,000 字符；图片、音频和资源等块仅给出不支持提示。通用远端读取不会自动成为本项目带引用校验的 `EvidenceBundle`。

工具先作为完整定义进入注册表，再参与检索路由和用户意图过滤，然后投影给模型。模型给出 tool call 后，[`tool-router.ts`](../../lib/agent/tools/tool-router.ts) 负责确认、危险工具拦截、限流、超时、执行与耗时元数据。这样 MCP 走的是本地工具治理路径，不是把 MCP SDK 返回的工具直接交给模型执行。

### 2.4 用户确认与继续执行

需要确认时，Agent 暂停该工具调用。[`continuation.ts`](../../packages/application/src/mcp/continuation.ts) 保存模型消息、待确认调用、预算、计划进度、已执行调用及工具配置指纹；[`confirmation-store.ts`](../../packages/infrastructure/src/mcp/confirmation-store.ts) 将状态加密存入 Redis，TTL 为 2 小时，并原子领取执行权。

确认请求在 [`confirm-tool.ts`](../../packages/application/src/mcp/confirm-tool.ts) 中重新打开该用户的外部工具会话，核对会话、工具及指纹，再继续执行和生成回复。浏览器提交确认凭据与调用 ID，不能替换原参数。配置或 Schema 变化会令旧确认失效。执行后若进程崩溃或结果未保存，写操作状态可能未知；实现不会自动放开重复执行。Redis/加密配置不可用时，依赖确认的调用不能可靠继续。

## 3. Skill：定义、发布与运行

### 3.1 两种形态

本仓库把标准 `SKILL.md` 说明与可执行沙盒版本放在同一个 Skill 定义下：

- **标准说明**：`skill_md` 与 `support_files` 是供 Agent 按需读取的文本。导入它们不会执行文件，也不会自动创建可执行版本。
- **可执行版本**：`sandbox_skill_versions` 中不可变的 `skillId + version`，绑定运行时、入口命令、Sandbox Profile、镜像 digest、Bundle SHA-256、网络策略和输入/输出 Schema 路径。只有发布过版本才能使用 `run_skill`。

两者可以并存；`list_skills` 中有 `skillMd` 的项目显示为 `standard`，即便它也有可执行版本。该字段是列表展示分类，不是对是否可执行的完整判断。数据读取见 [`skills.ts`](../../lib/sandbox/skills.ts)。

### 3.2 导入、管理与数据表

[`skill-center.tsx`](../../apps/web/features/skills/components/skill-center.tsx) 是 Skill 列表和详情界面：导入目录、启停、删除、编辑元数据、发布版本、创建并轮询测试 Run。`skillId` 写入 URL 查询参数，便于列表/详情导航。

| API | 用途 |
|---|---|
| `GET/POST/PATCH/DELETE /api/skills` | 列表、导入标准目录、修改元数据/启用状态、软删除 |
| `POST /api/skills/versions` | 发布不可变版本与 Bundle |
| `POST /api/skills/runs` | 从页面创建 Run |
| `GET/DELETE /api/skills/runs/{id}` | 查询或取消当前用户的 Run |

[`standard-skill.ts`](../../lib/sandbox/standard-skill.ts) 要求目录根部有 `SKILL.md`，从其 frontmatter 提取名称和描述，生成 Skill ID；附属文件以文本存入 `support_files`。单文件上限 2 MiB，目录总量 10 MiB，并检查相对路径。新导入项默认停用。`PATCH` 只更新已经存在的 Skill；删除是软删除，保留历史版本与 Run，有活跃或待执行 Run 时拒绝删除，已删除 ID 不能复用。

[`20260904-sandbox-runtime.sql`](../schemas/migrations/20260904-sandbox-runtime.sql) 定义 `sandbox_skills`、`sandbox_skill_versions`、`sandbox_runs`，版本表有防 UPDATE/DELETE 触发器及 Bundle digest 校验。随后应用 [`20260905-skill-list-detail.sql`](../schemas/migrations/20260905-skill-list-detail.sql) 补充旧表字段和管理 RPC。当前管理 API 仅要求登录，`GET /api/skills` 固定返回 `canEdit: true`：Skill 目录是登录用户共同管理的目录，并非按用户私有，也没有在这些 API 上按 `CONFIG_ADMIN_EMAILS` 限制编辑。

### 3.3 发布版本

页面将 tar Bundle 编码为 Base64，调用 `POST /api/skills/versions`。[`publishSkillVersion`](../../lib/sandbox/skills.ts) 校验 Skill ID、语义版本、`node`/`python` 运行时、固定入口格式、Profile 对应的镜像 digest、Bundle 大小与 Schema 相对路径，然后计算 SHA-256，通过数据库 RPC 保存不可变版本。Bundle 最大 10 MiB；Base64 会使 HTTP 请求体明显大于原文件。Profile 由服务端配置镜像 digest，前端不能为同一 Profile 发布任意镜像。

Bundle 至少应包含入口脚本和输入/输出 JSON Schema。运行时从 `/workspace/input.json` 读取输入，成功后写 `/workspace/result.json`。Bundle 路径、安全提取及 Schema `$ref` 约束详见 [Broker Skill 文档](../../apps/sandbox-broker/docs/skill-management.md)。

### 3.4 Agent 调用与 Broker 执行

[`builtin.ts`](../../lib/agent/tools/builtin.ts) 无条件注册三个内置工具，具体实现在 [`sandbox-skills.ts`](../../lib/agent/tools/sandbox-skills.ts)：

| 工具 | 参数 | 行为 |
|---|---|---|
| `list_skills` | 空对象 | 查询已启用且有说明或版本的 Skill，返回概要和版本列表 |
| `view_skill` | `skillId` | 读取已启用 Skill 的完整 `SKILL.md` 与附属文本 |
| `run_skill` | `skillId`、`skillVersion`、`input` | 创建沙盒 Run，最多轮询约 20 秒并返回状态、预览及 Artifact 引用 |

`run_skill` 要求登录用户身份。它计算幂等键，通过 [`lib/sandbox/client.ts`](../../lib/sandbox/client.ts) 调用 Broker 的 `POST /v1/skill-runs`；HTTP 请求使用时间戳、方法、路径、用户 ID 和原始 body 生成 HMAC。Agent 不能通过这个工具传入命令、容器镜像、挂载或网络配置。

Broker 在 [`handler.go`](../../apps/sandbox-broker/internal/api/handler.go) 中严格解码请求、核对用户、读取已发布且启用的 Skill 版本，再由该版本填入 Profile、入口、Bundle digest、镜像和超时，创建 Run。队列模式返回 `queued`；Worker 从 PostgreSQL claim Run、续租、重读版本并校验不可变绑定，最后交给容器执行器。执行器校验输入 Schema，安全解包 Bundle，创建受 Profile 限制的容器，收集有限长度日志，并在完成前校验 `result.json` 的输出 Schema。见 [`worker.go`](../../apps/sandbox-broker/internal/worker/worker.go) 和 [`executor.go`](../../apps/sandbox-broker/internal/executor/container/executor.go)。

`run_skill` 返回 `queued` 或 `running` 时，`ok: true` 只表示 Run 已受理、尚未进入终态，不能据此对用户宣称 Skill 已执行成功。只有 `completed` 是成功终态；`failed`、`timed_out`、`cancelled`、`dead`、`unavailable` 是失败或不可用终态。页面会每 2 秒查询 Run 状态，也支持取消。较大的结果只返回最多 8,000 字符预览，并给出 `resultRef`；日志也通过 Artifact 引用表示。

## 4. 权限、安全与故障边界

| 边界 | 当前实现 |
|---|---|
| MCP 服务归属 | 服务读写按 `user_id`；调用前再次比对执行上下文用户。Token 加密保存、不在列表返回。 |
| MCP 远端安全 | 仅公网 HTTPS、禁止重定向；远端工具注解不能覆盖本地确认策略。MCP 自身不隔离远端服务行为。 |
| Skill 管理 | 登录用户共享管理目录；操作记录 actor ID。若产品要求管理员专属编辑，当前 API 权限模型需要调整。 |
| Skill 执行 | Broker 只接受 Skill ID/版本/输入并从已发布版本解析特权字段；Worker 重读版本和镜像绑定。 |
| 沙盒隔离 | Profile 固定资源限制与禁网策略；真实隔离依赖目标主机上的 rootless 容器运行时和镜像配置。`SANDBOX_RUNTIME=disabled` 返回不可用，不会退回宿主机执行。 |
| 输出可信度 | MCP 普通读取和 Skill 动作回执都不自动构成带引用的 RAG 证据。远端工具文本和 `SKILL.md` 仍是外部内容。 |

主要故障路径：MCP 配置表缺失时管理页提示未初始化；单个 MCP 服务连接或 Schema 失败时跳过该服务；远端写操作中断后状态未知，不自动重试。Skill 配置表或版本缺失、Broker URL/HMAC 未配置、Worker 镜像未配置、容器运行时不可用时，`run_skill` 无法完成。Broker Run 的提交成功与最终执行成功应分别观察。

## 5. 部署前提与验证

| 模块 | 必要前提 |
|---|---|
| MCP | 应用数据库执行 `20260913-user-mcp-servers.sql`；`CONFIG_ENCRYPTION_KEY`；可访问的公网 HTTPS MCP 服务。确认流程还依赖 `REDIS_URL`。 |
| Skill | 先执行 `20260904-sandbox-runtime.sql`，再执行 `20260905-skill-list-detail.sql`；配置 `SANDBOX_BROKER_URL`、不少于 32 字节的 `SANDBOX_BROKER_AUTH_SECRET`、对应 Profile 镜像 digest；Broker 与 Worker 使用同一 PostgreSQL。 |
| 真实沙盒 | 在目标 Linux 主机验收 rootless Podman、镜像 digest、cgroup、网络隔离、超时/取消和 Artifact 存储。源码和单元测试不能替代这些验收。 |

可复核的检查顺序：

1. MCP：在页面测试连接、发现并启用一个只读工具；发起聊天，确认 Trace 中出现本地 `mcp_...` 工具调用；再验证需要确认的写操作及取消路径。无真实服务时可运行 `docs/mcp.md` 所列本地 HTTP 集成测试。
2. Skill：导入标准 `SKILL.md` 并启用，检查 `list_skills -> view_skill`；发布示例 Bundle 后创建 Run，持续查询直到终态并检查 `resultRef`。示例见 [`markdown-check`](../../apps/sandbox-broker/examples/skills/markdown-check)。
3. 代码门禁：根目录 `npm run check`；MCP 定向 Vitest 命令见 [MCP 接入](../mcp.md)；Broker 在 `apps/sandbox-broker` 内运行 `go test ./...`、`go vet ./...`。这些是静态/本地验证，目标环境仍需单独验收。
