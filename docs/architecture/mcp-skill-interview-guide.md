# MCP 与 Skill 实现：面试讲解稿

> 历史记录：以下 Go Sandbox Broker / Worker 讲解不再代表当前 Skill 执行路径。当前实现见 [E2B Skill Runtime](./e2b-skill-runtime.md)。

> 基于当前仓库源码整理。这里的“实现”表示代码中有相应路径；数据库迁移、远端 MCP 服务、Redis、Broker 和目标主机容器隔离是否可用，需要分别做运行验收。细节索引见 [MCP 与 Skill 模块实现](./mcp-skill-implementation.md)、[MCP 接入](../mcp.md)和 [Broker Skill 约定](../../apps/sandbox-broker/docs/skill-management.md)。

## 一、先用 1 分钟讲清楚

这个项目把 MCP 和 Skill 作为两种不同的能力来源，统一接入 Agent 的工具系统。MCP 用于接入用户配置的远端工具：服务端按用户读取配置，使用 MCP SDK 连接和发现工具，只把允许的工具包装成项目内部的 `ToolDefinition`。Skill 有两层：`SKILL.md` 是按需读取的操作说明；发布后的不可变 Bundle 才能由 `run_skill` 提交给 Sandbox Broker，在独立容器中运行。模型只看到工具名称、描述和输入 Schema，真正执行、权限校验、确认、超时和结果处理都在服务端完成。

面试中可以用一句话总结边界：**MCP 解决工具接入协议，Skill 解决可复用能力的说明和版本化执行，Tool Registry/Router 负责 Agent 治理，Sandbox Broker 负责实际隔离。**

## 二、先画系统图

```text
Web: MCP/Skill 管理页                 Web: Chat
        |                                |
        v                                v
 /api/mcp/*, /api/skills/*          /api/chat (认证)
        |                                |
        v                                v
 用户 MCP 配置 / Skill 定义       runChatUseCase (请求级组合)
                                         |
             +---------------------------+--------------------------+
             |                                                      |
      内置 ToolRegistry                                ExternalToolsPort.open(userId)
      list/view/run_skill                               MCP SDK 连接、发现、允许列表
             |                                          远端工具 -> ToolDefinition
             +---------------------------+--------------------------+
                                         |
                          路由/意图过滤 -> 模型工具 Schema
                                         |
                         模型 tool call -> Tool Router
                                         |
                         +---------------+---------------+
                         |                               |
                   MCP SDK callTool                Skill 读取 / Broker Run
                                                         |
                                             PostgreSQL 队列 -> Worker
                                                         |
                                               rootless 容器运行时
```

入口在 [聊天路由](../../app/api/chat/route.ts)；组合点在 [run-chat.ts](../../packages/application/src/chat/run-chat.ts)；生产依赖在 [infrastructure chat](../../packages/infrastructure/src/chat/index.ts) 装配。内部工具契约见 [types.ts](../../lib/agent/tools/types.ts)，注册表的模型投影见 [registry.ts](../../lib/agent/tools/registry.ts)。`ToolDefinition` 包含 `execute`、风险、运行策略、输出可信度等本地字段；模型只收到 `name`、`description`、`input_schema`。因此模型提出调用，服务端决定能否执行。

| 对比 | MCP | Skill |
|---|---|---|
| 来源 | 每个用户自己配置的远端 MCP 服务 | 共享的 Skill 目录及发布版本 |
| Agent 可见形式 | 每个获准远端工具对应一个 `mcp_...` 名称 | 三个固定内置工具：`list_skills`、`view_skill`、`run_skill` |
| 核心行为 | 协议连接、发现和 `callTool` | 读取说明，或将版本化输入提交给 Broker |
| 隔离 | MCP 本身不提供进程隔离 | 可执行 Bundle 由独立 Worker/容器运行 |
| 存储范围 | `user_mcp_servers` 按 `user_id` 隔离 | `sandbox_skills` 是登录用户共享目录，Run 绑定用户 |

## 三、MCP：从配置到一次调用

### 3.1 用户配置与允许列表

在 [MCP 页面](../../apps/web/features/connections/components/mcp-center.tsx)，用户填写名称、公网 HTTPS 地址和可选 Bearer Token，先测试连接、发现工具，再选择允许的工具和确认方式，最后保存。`/api/mcp/servers` 与 `/api/mcp/discover` 都先验证登录用户。配置读写在 [user-config.ts](../../packages/infrastructure/src/mcp/user-config.ts)：查询显式加 `user_id`，数据库迁移还启用 RLS；Token 加密存储，列表只返回是否已配置。更换 URL 时必须重新输入或清除 Token，避免旧凭据发往新端点。

允许列表是本地策略，不直接信任服务端发现结果。每个用户最多 8 个服务；一个启用服务最多允许 32 个工具。保存时校验配置结构、重复名称和至少一个已启用工具。默认 `approval: always`；选择 `read-only` 后才映射为免确认读取。这里的“只读”是用户的配置判断，不是 MCP 服务提供的强制保证。

### 3.2 请求级连接与发现

模型支持工具时，[run-chat.ts](../../packages/application/src/chat/run-chat.ts) 调用 `ExternalToolsPort.open(userId)`。基础设施层只读取当前用户启用的配置，为每个服务建立独立会话；一个服务失败会跳过该服务，其余服务和内置工具仍可用。连接、发现和适配在 [client.ts](../../packages/infrastructure/src/mcp/client.ts)；使用官方 MCP SDK 的 `Client` 和 `StreamableHTTPClientTransport`，支持分页发现，限制初始化时间和页数，禁用重试与重定向，网络请求经过公网 URL 安全检查。请求结束、取消或异常时关闭连接；有状态会话尽力发送 DELETE。

发现工具不等于授权工具。代码按保存的工具名寻找远端工具；允许的工具缺失、Schema 过大或无法编译时，该服务本轮不可用。上下文预览也会打开连接以估算 Schema token 占用，结束后关闭，不执行工具。配置在下一轮请求重新读取，当前会话不热更新。

### 3.3 适配到本地工具契约

[mcp-adapter.ts](../../lib/agent/tools/mcp-adapter.ts) 为获准工具生成稳定的 `mcp_..._<hash>` 名称，并用 AJV 编译远端参数 Schema。适配器保留远端名称供真正调用，调用前再次核对 `userId`、校验参数。写入或外部操作至少需要 `confirm`；远端注解不能降低本地风险等级。工具配置包含 30 秒默认调用超时、频率限制和服务级并发组，普通 MCP 工具标记为 `sandboxed: false`。

完整 `ToolDefinition` 先进入注册表，再经检索路由和用户意图过滤，最后投影给模型。模型返回 tool call 后，[tool-router.ts](../../lib/agent/tools/tool-router.ts) 检查确认状态、危险工具、限流和超时，再执行适配器的 `callTool`。远端 `isError: true` 会变成失败；文本和结构化内容被规范化并限制进入模型的长度。图片、音频、资源等内容块目前只显示不支持提示。普通远端读取不自动成为带引用验证的 RAG 证据。

### 3.4 确认后如何恢复

对于需要确认的工具，Router 返回 `pending_confirmation`，Agent 暂停。服务端在 [continuation.ts](../../packages/application/src/mcp/continuation.ts) 保存消息、待确认调用、原参数、工具指纹、剩余预算和计划进度；[confirmation-store.ts](../../packages/infrastructure/src/mcp/confirmation-store.ts) 把加密记录放入 Redis，TTL 两小时，用单条记录原子领取执行权。浏览器只提交确认凭据与调用 ID，不能修改参数。

[confirm-tool.ts](../../packages/application/src/mcp/confirm-tool.ts) 恢复时重新打开该用户的工具会话，核对会话和工具指纹，再执行原调用并续接模型。服务地址、权限、Schema 或运行策略变化会使旧确认失效。远端写操作执行后若进程崩溃，结果可能未知；实现保留占用状态，不自动重试该写操作。这个设计能减少重复执行风险，但不能承诺远端系统的 exactly-once 效果。

## 四、Skill：说明文件与可执行版本

### 4.1 两种形态不要混为一谈

标准 Skill 是根目录 `SKILL.md` 加附属文本文件。上传时 [standard-skill.ts](../../lib/sandbox/standard-skill.ts) 解析名称、描述，检查相对路径与大小，并把说明文本存入数据库；导入本身不运行文件，默认停用。启用后 Agent 用 `list_skills` 找到它，再用 `view_skill` 按需读取完整说明。这样完整 `SKILL.md` 不会在每一轮都塞入系统提示词。

可执行 Skill 还需要发布不可变的 `skillId + version`。版本绑定运行时、固定入口、Sandbox Profile、镜像 digest、Bundle SHA-256，以及输入/输出 JSON Schema 路径。一个 Skill 可以同时有说明和可执行版本；列表中的 `kind: standard` 只表示存在 `skillMd`，不能据此判断它不能执行。数据读取与发布逻辑在 [skills.ts](../../lib/sandbox/skills.ts)。

### 4.2 管理与发布

[Skill 页面](../../apps/web/features/skills/components/skill-center.tsx) 支持导入、启停、编辑元数据、软删除、发布版本和测试 Run。`/api/skills`、`/api/skills/versions` 与 `/api/skills/runs` 都要求登录。当前管理 API 对所有登录用户返回 `canEdit: true`，并按 actor ID 记录写入；它不是管理员专属管理，也不是每人私有 Skill 库。删除保留版本和历史 Run，有活跃或排队 Run 时拒绝删除。

发布时，应用验证语义版本、`node`/`python` 入口、Profile 对应的服务端镜像 digest、Schema 相对路径和 10 MiB Bundle 上限，计算 SHA-256 后通过数据库 RPC 写入不可变版本。页面使用 Base64 JSON 上传，10 MiB Bundle 会膨胀到约 13.3 MiB；这对反向代理请求体大小有实际要求。数据库迁移在 [sandbox-runtime.sql](../schemas/migrations/20260904-sandbox-runtime.sql) 和 [skill-list-detail.sql](../schemas/migrations/20260905-skill-list-detail.sql)。

### 4.3 Agent 调用三个内置工具

[builtin.ts](../../lib/agent/tools/builtin.ts) 注册三个工具，实现位于 [sandbox-skills.ts](../../lib/agent/tools/sandbox-skills.ts)：

| 工具 | 作用 | 关键边界 |
|---|---|---|
| `list_skills` | 列出已启用且有说明或版本的 Skill | 只返回概要和版本信息 |
| `view_skill(skillId)` | 读取完整 `SKILL.md` 和附属文本 | 只读取已启用、未删除的 Skill |
| `run_skill(skillId, skillVersion, input)` | 创建沙盒 Run 并短暂轮询 | 调用方不能传命令、镜像、挂载或网络参数 |

`run_skill` 要求登录用户 ID，用用户、请求、Skill 版本和输入生成幂等键。它经 [sandbox client](../../lib/sandbox/client.ts) 调用 `POST /v1/skill-runs`，使用时间戳、HTTP 方法、路径、用户 ID 和原始 body 计算 HMAC。调用端轮询最多约 20 秒；如果此时仍为 `queued`/`running`，工具返回 `ok: true` 只表示受理，**不是执行完成**。只有 `completed` 是成功终态。较大结果给出截断预览和 Artifact 引用。

### 4.4 Broker 和 Worker 如何约束执行

[Broker handler](../../apps/sandbox-broker/internal/api/handler.go) 严格解码请求并拒绝未知字段，校验 HMAC 所绑定的用户，读取已启用的发布版本，再从版本解析 Profile、入口、Bundle 与镜像，而非相信调用者提交的特权字段。队列模式写入 PostgreSQL Run 后返回 `queued`。[Worker](../../apps/sandbox-broker/internal/worker/worker.go) 领取 Run、续租，执行前重读版本并核对 Bundle/Profile/镜像绑定，防止队列记录偏离发布版本。

[容器执行器](../../apps/sandbox-broker/internal/executor/container/executor.go) 校验 Bundle digest、安全解包到独立 Workspace，在创建容器前验证 `/workspace/input.json`，按 Profile 限定 CPU、内存、PID、超时、网络和非 root 用户；完成后读取并验证 `/workspace/result.json`，把结果、日志作为 Artifact 保存。当前内置 Profile 网络均为 `disabled`。生产隔离的有效性还取决于目标主机的 rootless Podman、cgroup 与镜像配置；`SANDBOX_RUNTIME=disabled` 表示不可用，不会自动退回宿主机执行。

## 五、面试官可能追问

**为什么不把 MCP SDK 的工具直接传给模型？** 因为项目已有工具风险、确认、限流、超时、Trace 和输出可信度策略。先适配为 `ToolDefinition`，才能让远端工具经过同一个执行边界；模型仅收到 Schema，不能直接调用网络服务。

**MCP 和 Skill 有什么区别？** MCP 是客户端与远端服务之间的标准协议；Skill 是可复用的说明或版本化执行单元。项目既可以通过 MCP 调远端工具，也可以通过内置工具读取/运行 Skill。二者最终共享 Agent 工具治理，但执行位置不同。

**怎样防止提示注入？** MCP 描述、返回文本和 `SKILL.md` 都按外部内容看待；远端注解不能覆盖本地风险策略，普通远端读取不会自动升级为带引用证据。不过当前实现并不能保证模型完全不受恶意文本影响，面试时应把边界描述为“限制能力与可信度”，不要说成“彻底消除提示注入”。

**如何保证写操作不重复？** 用户确认记录绑定原参数和配置指纹，Redis 原子领取执行权；写操作结果未知时不自动释放重试。MCP 适配器本身也不自动重试。远端操作和本地确认记录之间没有分布式事务，不能承诺 exactly-once。

**为什么版本要不可变？** Run、审计和复现都需要指向确定的 Bundle、入口、Schema 与镜像。发布时做 digest 校验，Worker 执行前重新核对绑定，防止“排队时是 A，运行时变成 B”。

**Skill 是否天然安全？** 不是。`SKILL.md` 是外部文本；可执行 Bundle 的安全依赖发布审核、固定版本/Profile 和目标环境的容器隔离。当前 `run_skill` 在 Agent 工具策略中标记为 `safe`、`sideEffect: none`，这建立在已发布版本受控、内置 Profile 禁网的前提上；若未来允许网络或真实外部写入，需要重新评估确认和风险等级。

**有哪些当前限制？** MCP 只支持 Streamable HTTP、公网 HTTPS 和可选 Bearer Token，没有 OAuth、stdio、Resources 或 Prompts 接入。MCP 通用结果不自动成为可引用证据。Skill Bundle 通过 Base64 JSON 上传，目录为登录用户共享；Agent 轮询有时间窗口，Run 可能尚未完成。应用层工具限流是进程内状态，不能当作跨实例的全局配额。

## 六、现场演示与验证口径

1. MCP：配置一个可访问的测试服务，发现工具并仅允许一个只读工具；发起聊天，在 Trace 中观察 `mcp_...` 调用；再把一个工具设为需要确认，展示暂停、确认和续接。测试连接只证明当次握手和发现成功，不证明之后每次调用成功。
2. Skill：导入并启用示例 `SKILL.md`，展示 `list_skills -> view_skill`；发布 [markdown-check](../../apps/sandbox-broker/examples/skills/markdown-check/SKILL.md) 的 Bundle，提交 Run，轮询到终态并查看结果引用。不要把 `queued` 当成成功截图。
3. 自动检查：根目录运行 `npm run check`，MCP 定向测试命令见 [MCP 接入](../mcp.md)；Broker 目录运行 `go test ./...` 和 `go vet ./...`。这些检查验证代码路径，真实数据库、Redis、MCP 服务与目标主机隔离仍需单独验收。

面试时推荐按“问题 -> 决策 -> 代码链路 -> 失败语义 -> 局限”讲述。例如：“为了避免外部工具绕过本地确认，我把 MCP 发现结果适配成内部工具定义；用户配置决定允许列表和风险，Router 执行确认与超时，远端写入中断后状态未知，因此不做自动重试。”这比只罗列技术名词更能说明工程判断。
