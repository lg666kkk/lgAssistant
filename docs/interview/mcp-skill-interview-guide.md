# MCP 与 Skill 实现面试讲解稿

> 历史记录：以下 Go Sandbox Broker / Worker 部分不再代表当前 Skill 执行路径。当前实现见 [E2B Skill Runtime](../architecture/e2b-skill-runtime.md)。

> 用途：面试时讲清楚本项目 MCP 接入与 Skill 沙盒执行“怎么做的、为什么这么做、边界在哪”。
> 事实依据：本文所有结论都来自当前源码（2026-09 版本），每个关键点附代码位置。架构说明见 [mcp-skill-implementation.md](../architecture/mcp-skill-implementation.md)，本文侧重“讲法 + 追问”。
> 原则：**做了的讲清楚机制，没做的明确说没做**。第 7 节列出了已知缺口，被追问时直接用。

---

## 0. 先背下来的三段话

### 30 秒版

> 项目里 MCP 和 Skill 都挂在同一套自建工具体系下：`ToolDefinition → ToolRegistry → Tool Router`。
> **MCP** 是按用户配置的远端工具。我用官方 SDK 通过 Streamable HTTP 连接，把发现到的工具适配成本地 `ToolDefinition`，所以确认、限流、超时、参数校验全部由本地 Router 执行，不信任远端自报的元数据。写操作需要用户确认，确认状态加密存在 Redis，确认后可以从断点继续执行 Agent 循环。
> **Skill** 分两种：标准 `SKILL.md` 是给模型按需读取的说明；可执行 Skill 是发布成不可变版本的代码包，由 Go 写的 Sandbox Broker 放进禁网、只读、限资源的容器里执行。模型只能传 `skillId + version + input`，命令、镜像、网络这些特权字段全部从已发布版本里读，模型改不了。

### 2 分钟版（按这个顺序讲）

1. **统一抽象**：所有工具都是 `ToolDefinition`，包含给模型看的 `name/description/input_schema`，以及只留在本地的 `riskLevel/runtime/outputPolicy/execute`。MCP 工具和 Skill 工具都只是不同的 `execute` 实现。
2. **MCP 链路**：配置页保存服务 → 每次聊天请求按用户打开连接 → `listTools` 发现 → 与用户白名单求交集 → 适配成 `mcp_xxx_hash` 工具注册进 Registry → 模型调用 → Router 治理 → SDK `callTool`。
3. **MCP 确认续跑**：遇到需要确认的工具，Agent 循环暂停，把消息历史、预算、计划进度、工具指纹做成 checkpoint，加密存 Redis（TTL 2 小时）。用户确认后用 Lua 原子领取，校验工具指纹没变，执行后接着跑 Agent 循环。
4. **Skill 链路**：`list_skills → view_skill → run_skill` 三个固定工具，采用渐进式披露。`run_skill` 用 HMAC 签名请求 Broker，Broker 用 Postgres 队列排队，Worker 用 `SKIP LOCKED` 领取任务并续租，再次校验版本绑定，最后在容器里执行，并校验输入和输出的 Schema。
5. **安全立场**：MCP 是协议不是沙盒，所以 MCP 靠“本地治理 + 用户确认”；Skill 执行不可信代码，所以靠“不可变版本 + 容器隔离”。

---

## 1. 全景架构

```text
                           ┌──────────── Next.js 应用（TypeScript） ────────────┐
浏览器 ── POST /api/chat ──► runChatUseCase (packages/application/src/chat/run-chat.ts)
                           │   ├─ createBuiltinToolRegistry()   ← 含 list/view/run_skill
                           │   ├─ openExternalToolSession()     ← ExternalToolsPort
                           │   │     └─ createManagedMcpToolsPort (infrastructure)
                           │   │           ├─ 读 user_mcp_servers（按 user_id）
                           │   │           └─ connectMcpServer → adaptMcpTool
                           │   ├─ 检索路由过滤 + 用户意图过滤 → listForModel()
                           │   └─ runAgentLoop → 模型返回 tool_use
                           │                     └─ executeToolCall (tool-router.ts)
                           │                           ├─ 确认 / 危险拦截 / 限流 / 超时
                           │                           └─ tool.execute()
                           └──────────────┬──────────────────────┬──────────────┘
                                          │                      │
                           MCP SDK callTool│                      │HMAC 签名 HTTP
                                          ▼                      ▼
                             用户的远端 MCP 服务      Sandbox Broker (Go)
                             (公网 HTTPS)             ├─ POST /v1/skill-runs → Postgres 队列
                                                      └─ Worker: claim(SKIP LOCKED) + 续租
                                                           └─ podman/docker 容器
                                                               --network=none --read-only
                                                               --cap-drop=ALL 非 root ...
```

| 维度 | MCP | Skill |
|---|---|---|
| 能力来源 | 用户自己配置的远端服务 | 全体登录用户共享的 Skill 目录 |
| 模型看到的工具 | 每个获准的远端工具对应一个 `mcp_...` 工具（动态） | 固定三个：`list_skills` / `view_skill` / `run_skill` |
| 在哪执行 | 远端 MCP 服务 | 说明在应用端读取；代码在 Broker/Worker 容器里执行 |
| 隔离手段 | 无（MCP 只是协议）→ 靠本地治理和确认 | 容器隔离 + 不可变版本 |
| 身份范围 | 配置和连接按用户隔离 | 目录共享，Run 按用户提交和查询 |

**面试亮点**：MCP 和 Skill 没有另起一套执行框架，都复用同一个 Registry/Router。这样确认、限流、超时、Trace、续跑这些横切能力都是一次实现、到处生效。

---

## 2. 基础：统一工具抽象

代码：[`lib/agent/tools/types.ts`](../../lib/agent/tools/types.ts)、[`registry.ts`](../../lib/agent/tools/registry.ts)、[`tool-router.ts`](../../lib/agent/tools/tool-router.ts)

```ts
interface ToolDefinition {
  name; description; input_schema;       // ← 投影给模型
  capabilities: string[];                // 稳定能力标签，如 mcp.<server>.<tool>
  riskLevel: "safe" | "confirm" | "dangerous";
  runtime: ToolRuntimePolicy;            // 超时/限流/并发组/副作用/是否需确认
  outputPolicy: { grounding: "authoritative_result" | "cited_evidence" | "action_receipt" | "none" };
  configurationRevision?: string;        // MCP 配置版本，参与指纹计算
  execute(params, context): Promise<ToolResult>;
}
```

- `registry.listForModel()` **只投影** `name / description(+能力标签) / input_schema`。风险策略、执行函数都不会发给模型，模型只能“提议”调用。
- `executeToolCall` 的执行顺序：工具存在 → `confirm` 且未批准时返回 `pending_confirmation` → `dangerous` 直接拒绝 → 按 `scopeId:toolName` 做 1 分钟固定窗口限流 → `withTimeout` 包一层 `AbortController` 执行 → 附加耗时和成本元数据。
- `outputPolicy.grounding` 决定工具输出在最终回答里算什么：MCP 读操作是 `none`（不当作可信证据），写操作和 `run_skill` 是 `action_receipt`（只证明动作发生了，不证明事实）。

---

## 3. MCP 实现详解

### 3.1 配置管理

代码：[`packages/infrastructure/src/mcp/user-config.ts`](../../packages/infrastructure/src/mcp/user-config.ts)、[`app/api/mcp/*`](../../app/api/mcp)、[`mcp-center.tsx`](../../apps/web/features/connections/components/mcp-center.tsx)

| API | 作用 |
|---|---|
| `GET/POST /api/mcp/servers` | 列出、新增本人的服务 |
| `PATCH/DELETE /api/mcp/servers/{id}` | 编辑、删除 |
| `POST /api/mcp/discover` | 测试连接并发现工具，不落库 |

表 `user_mcp_servers`（[迁移](../schemas/migrations/20260913-user-mcp-servers.sql)）：`user_id`、`url`、`enabled`、`token_ciphertext`、`tools JSONB`。开启 RLS，并对 `anon/authenticated` 执行 `REVOKE ALL`，浏览器端无法直接读写，只能经过服务端路由（每个路由先 `requireUser`，查询都带 `.eq("user_id", userId)`）。

保存时的校验（`parseMcpDraft` + `saveMcpServer`）：
- AJV 严格校验结构，工具名不能重复；启用的服务至少要允许一个工具；每个服务最多 32 个启用工具，每个用户最多 8 个服务。
- **URL 只接受公网 HTTPS**：拒绝 IPv6 字面量主机，并调用 `assertPublicProviderUrl` 做 SSRF 检查。
- **Token 使用 AES-256-GCM 加密存储**，列表接口只返回 `tokenConfigured: boolean`。
- **换 URL 必须重填 Token**（`resolveToken`）：防止攻击者把 URL 改成自己的服务器，骗走已保存的凭据。这个点很适合讲。
- 每个工具的确认策略只有两档：`approval: "always"`（默认，映射为 `confirm + external`）和 `"read-only"`（映射为 `safe + read`）。

### 3.2 连接与发现（每次请求一个会话）

代码：[`client.ts`](../../packages/infrastructure/src/mcp/client.ts) `connectMcpServer`、[`session.ts`](../../packages/application/src/mcp/session.ts)、`createManagedMcpToolsPort`

```ts
new StreamableHTTPClientTransport(new URL(config.url), {
  requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  fetch: (url, init) => safeFetch(url, { ...init, redirect: "error", signal: AbortSignal.any([...]) }),
  reconnectionOptions: { maxRetries: 0, ... },
});
```

要点：
- **传输层**：用官方 `@modelcontextprotocol/sdk` 的 Streamable HTTP（MCP 当前推荐的远程传输方式），不支持 stdio。服务端部署的应用不应该替用户拉起本地进程。
- **`redirect: "error"`**：禁止重定向，防止 Bearer Token 被 30x 带到其他主机。
- **`createSafeProviderFetch`**：请求层再做一次公网地址检查。
- **超时**：初始化和每页 `listTools` 都是 10 秒；分页最多 20 页，并检测重复 cursor，防止恶意服务端让客户端无限翻页。
- **白名单求交**：发现结果只用来匹配用户保存的白名单。白名单里的工具如果在远端消失，或 Schema 超过 32KB，**整个服务本轮初始化失败**（fail-closed）。
- **故障隔离**：`Promise.allSettled` 并发连接多个服务，某个服务失败只影响它自己，其他 MCP 服务和内置工具照常可用。
- **生命周期**：连接跟随一次聊天请求（request-scoped）。请求正常结束、客户端断开或异常时都会 `close()`：对有状态会话尽力发送 `DELETE`（1 秒上限），再关闭 client 和 transport。`close` 用 `closing ??=` 保证幂等。
- **配置不热更新**：配置改动在下一轮聊天生效，正在执行的会话不受影响。

### 3.3 远端工具 → 本地 ToolDefinition（适配器）

代码：[`lib/agent/tools/mcp-adapter.ts`](../../lib/agent/tools/mcp-adapter.ts)

1. **稳定命名**：`mcp_${清洗后的 serverId_remoteName 截断到 42 位}_${sha256([serverId, remoteName]) 前 16 位}`，总长不超过 63。这样解决三个问题：各模型厂商对工具名的字符和长度限制、不同服务之间工具重名、名字截断后碰撞。
2. **参数校验**：每个工具单独 `new Ajv()` 编译远端 Schema，避免不同服务的 `$id` 互相冲突；拒绝 `$async` Schema。执行前先校验参数，**再次核对 `context.userId === 创建时的 userId`**。
3. **风险策略本地定**：`sideEffect !== "read"` 时强制 `confirm`。远端的 annotations（如 `readOnlyHint`）**不参与决策**，只有用户在本地勾选“只读免确认”才会放行。
4. **运行策略**：超时 30 秒、限流 30 次/分钟、并发组 `mcp.<serverId>`、最大并发 2、`sandboxed: false`（如实声明没有隔离）。
5. **结果归一化**：文本块和 `structuredContent` 拼成 `content`，截断到 16,000 字符；超长时 `data` 置空，避免在 Trace 或消息里留下无上限的副本。图片、音频、资源类的块只给出“不支持”提示。`isError: true` 转为 `ok: false`。
6. **不自动重试 + 错误脱敏**：传输异常可能带出 URL 或 header，所以统一返回固定文案。写操作失败时返回“远端操作状态未知，请先核实再重试”，因为自动重试可能导致重复写入。

### 3.4 与 Agent 主流程的集成

`run-chat.ts`：
```ts
const toolRegistry = createBuiltinToolRegistry({ knowledgeProfile, retrievalPlan });
const external = await openExternalToolSession({ port: model.supportsTools ? deps.externalTools : undefined, ... });
for (const tool of external.tools) toolRegistry.register(tool);
// 先在完整 ToolDefinition 上按元数据做检索路由过滤，再做用户意图过滤，最后投影成模型 schema
```
- 模型不支持工具调用时，**根本不会建立 MCP 连接**，省掉握手开销。
- `ExternalToolsPort` 是 application 层定义的端口，MCP SDK、凭据解密都在 infrastructure 层，符合依赖倒置（见 [module-boundaries.md](../architecture/module-boundaries.md)）。
- 上下文预览（估算工具 Schema 占多少 token）走同一条发现路径，但不调用远端工具。

### 3.5 人工确认与断点续跑（最有深度的部分）

代码：[`continuation.ts`](../../packages/application/src/mcp/continuation.ts)、[`confirmation-store.ts`](../../packages/infrastructure/src/mcp/confirmation-store.ts)、[`confirm-tool.ts`](../../packages/application/src/mcp/confirm-tool.ts)

**暂停**：Router 对未批准的 `confirm` 工具返回 `pending_confirmation`，Agent 循环以 `awaiting_tool_confirmation` 停下。`checkpoint()` 生成 `Continuation`：
- `messages`：完整的模型协议消息，包括原始 `tool_use` ID
- `pending`：待确认的调用；`fingerprints`：每个待确认工具的指纹
- `remainingIterations / spentTokens / retrievalCalls`：预算接续
- `executedToolKeys`：已成功执行的调用 key，续跑时去重
- `plan / planStep / planControl`：Plan-and-Execute 的进度
- `evidenceBundles / capabilities / sources`

**存储**：Redis，`SETEX` TTL 7200 秒，key 为 `tool-confirmation:{userId}:{uuid}`，**整个 payload 用应用密钥加密**（里面有对话内容）。前端只拿到 `confirmationToken`。

**原子领取**（Lua 脚本）：
```lua
local v=redis.call('GET',KEYS[1]); if not v then return '' end
local r=cjson.decode(v); if r.busy then return 'BUSY' end
r.busy=true; local ttl=redis.call('TTL',KEYS[1]); ...; redis.call('SETEX',KEYS[1],ttl,cjson.encode(r))
return r.payload
```
- **锁标记和状态放在同一个 key**，注释里写了原因：在 `allkeys-lru` 淘汰策略下，Redis 可能淘汰整条记录，但不会出现“锁被单独淘汰、状态还在”导致写操作被重放的情况。
- 双击或并发确认时，第二个请求拿到 `BUSY`，提示“请先核实结果，不要重复执行”。

**续跑校验**（`confirmTool`）：
1. `sessionId` 必须一致；如果这个 `callId` 已有保存的响应，直接重放事件（幂等）。
2. 重新打开该用户的 MCP 会话，重建 Registry。
3. **`toolFingerprint` = sha256(name, schema, runtime, risk, configurationRevision)**，和 checkpoint 时的指纹比对。用户在等待期间改了配置，或者远端改了 Schema，旧确认就作废。
4. **参数不可替换**：执行时用的是服务端保存的 `pending.input`，浏览器只提交 token 和 callId。
5. 执行后用 `replaceToolResult` 把占位的 `tool_result` 换成真实结果，然后接着跑 `runAgentLoop` 或 `executePlan`。续跑中再遇到需要确认的工具，就生成新的 checkpoint 和 token，形成链式确认。

**崩溃语义**：执行前设置 `safeToRelease = false`。之后如果进程崩溃，锁**不会释放**，这条记录会一直停在 BUSY 直到 TTL 过期。系统宁可让用户手动核实，也不自动重放可能已经提交过的写操作（at-most-once）。

**附带能力**：同一套机制复用给了 `ask_user` 工具（`awaiting_user_input` → `action: "answer"`），问答和确认共用一条续跑链路。

---

## 4. Skill 实现详解

### 4.1 两种形态

| 形态 | 存储 | 模型如何使用 | 是否执行代码 |
|---|---|---|---|
| **标准 Skill** | `sandbox_skills.skill_md` + `support_files`（JSONB 文本） | `view_skill` 读取说明后按说明行动 | 否 |
| **可执行 Skill** | `sandbox_skill_versions`（不可变，含 bundle） | `run_skill` 提交 Run | 是，在容器里执行 |

同一个 Skill ID 下两种形态可以同时存在。

**为什么设计成三个固定工具，而不是每个 Skill 一个工具？**
这是**渐进式披露**（progressive disclosure，与 Anthropic Agent Skills 的思路一致）：`list_skills` 只返回名称、描述和版本 Schema 摘要；需要时再 `view_skill` 加载完整说明。Skill 数量增加时，工具 Schema 占用的 token 基本不变。代价是多一轮工具调用。

### 4.2 导入与发布

代码：[`standard-skill.ts`](../../lib/sandbox/standard-skill.ts)、[`skills.ts`](../../lib/sandbox/skills.ts)、[`app/api/skills/*`](../../app/api/skills)

**导入标准 Skill**：
- 目录根部必须有 `SKILL.md`，从 frontmatter 读取 `name/description`，由 name 生成 ID（`^[a-z0-9][a-z0-9-]{0,63}$`）。
- 拒绝绝对路径、`..` 和 `.git`；单文件不超过 2MiB，总大小不超过 10MiB；**新导入的 Skill 默认停用**。
- 只存文本，不执行任何文件。

**发布可执行版本**（`publishSkillVersion`）：
- 版本号使用 semver；运行时只允许 `node` / `python`；入口必须是 `node|python3 <bundle 内相对路径>`。
- **镜像 digest 由服务端的 Profile 配置决定**，前端提交的值必须和 Profile 一致，不能为同一 Profile 指定任意镜像。
- Bundle 大小 ≤ 10MiB，由服务端计算 SHA-256 后调用 RPC 入库。
- **数据库层保证不可变**：
  - `BEFORE UPDATE OR DELETE` 触发器直接报错 “published sandbox skill versions are immutable”；
  - `CHECK (encode(digest(bundle,'sha256'),'hex') = bundle_sha256)`，由数据库自己验证哈希；
  - `network = 'disabled'` 是 CHECK 约束；runs 表对版本表的外键是 `ON DELETE RESTRICT`。
- Skill 删除是软删除；有活跃 Run 时拒绝删除；已删除的 ID 不能复用，防止旧 Run 的引用指向新内容。

### 4.3 `run_skill`：应用侧

代码：[`sandbox-skills.ts`](../../lib/agent/tools/sandbox-skills.ts)、[`lib/sandbox/client.ts`](../../lib/sandbox/client.ts)

- 输入只有 `skillId / skillVersion / input` 三个字段，`additionalProperties: false`。**模型无法传入命令、镜像、挂载或网络配置。**
- 幂等键 = `sha256(userId, requestId, skillId, version, input)`：同一请求内重复调用不会创建两个 Run。
- **HMAC 签名**：`canonical = ts \n METHOD \n path \n userId \n body`，用 HMAC-SHA256 计算，要求密钥至少 32 字节；请求头包括 `X-Sandbox-Timestamp/Signature/User-ID`。
- 同步轮询最多约 20 秒（每 500ms 一次）。超时仍未结束时返回 `queued/running`，此时 `ok: true` 只表示“已受理”。输出超过 8000 字符会截断，并返回 `resultRef` 指向 Artifact。
- 页面上还有独立的 Run 管理：每 2 秒查询状态，支持取消。

### 4.4 Sandbox Broker（Go）

代码：`apps/sandbox-broker/internal/*`

**认证**（`auth/hmac.go`）：用 `RequestURI` 参与签名（路径和查询参数都被保护）；时间戳窗口 ±300 秒（可在 30～900 秒之间配置）；`hmac.Equal` 常量时间比较；请求体上限 64KiB。

**创建 Run**（`api/handler.go`）：
1. 严格解码：`DisallowUnknownFields`，并要求第二次 `Decode` 必须返回 EOF，拒绝请求体尾部夹带多余 JSON。
2. Header 里的 userId 必须等于 body 里的 userId。
3. 加载已发布且启用的版本，**重新校验 manifest 和 bundle SHA-256**。
4. **特权字段全部来自版本或 Profile**：`command = manifest.Entrypoint`、`imageDigest`、`bundleSha256`、`profileId`、`timeoutSeconds`。请求只提供 `input`。
5. 幂等：`ON CONFLICT (user_id, idempotency_key) DO NOTHING`。冲突时比较 `input_hash`，不同返回 409（同一个 key 被用于不同输入），相同则返回已有 Run。
6. Postgres 模式下只入队，返回 202 + `queued`。
7. 查询别人的 Run 返回 404 而不是 403，避免泄露 Run 是否存在。

**状态机**（`domain/state_machine.go`，Postgres 触发器里有同样的规则）：
```text
queued → preparing → running → collecting_artifacts → completed
             ↘ retry_wait ↗      ↘ failed / timed_out / cancelled / dead
终态：completed, failed, timed_out, cancelled, dead, unavailable
```

**队列与 Worker**（`queue/postgres`、`worker/worker.go`、SQL `claim_sandbox_runs`）：
- `FOR UPDATE SKIP LOCKED` 批量领取 1～20 个任务。可领取的条件：`queued/retry_wait` 已到重试时间，或者**处于执行中但租约过期**（Worker 崩溃后的回收）。
- 领取时 `attempts+1`，生成新的 `lease_token`，租约 15～1800 秒。
- **Fencing**：所有写操作都带 `worker_id + lease_token + lease_until > NOW()` 条件。失去租约的旧 Worker 写不进结果，这是防止“僵尸 Worker”的标准做法。
- 心跳续租，同时轮询 `cancel_requested_at`。租约丢失或收到取消请求时，取消 context 并停止容器。
- 重试采用指数退避 `5·2^(n-1)` 秒，上限 300 秒；`attempts >= max_attempts(3)` 时置为 `dead`。**Schema 校验失败属于确定性错误，直接 `failed`，不重试。**
- **执行前再次校验绑定**：Worker 重新读取版本，要求 skillId、version、bundleSha256、profileId、imageDigest、entrypoint 与 Run 记录完全一致，镜像 digest 也要和 Worker 本地配置一致。这是纵深防御：即使 Broker 被绕过，Worker 也不会执行被篡改的 Run。
- 启动时清理带有本 Worker 标签的孤儿容器。

**容器执行**（`executor/container`、`runtime/cli/command.go`）：
```text
podman|docker create --pull=never --read-only --network=none
  --cap-drop=ALL --security-opt=no-new-privileges
  --pids-limit=64 --memory=256m --cpus=0.5          # skill-trusted profile
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m
  --mount=type=bind,src=<workspace>,dst=/workspace --workdir=/workspace
  --init --stop-timeout=2 --user=<非0 UID>:<GID> [--userns=keep-id]
  image@sha256:...
```
- **Bundle 解包安全**：先校验 SHA-256 再解包；最多 10,000 个条目，解包后总大小 ≤ 100MiB；拒绝绝对路径、`..`、`.git`、`.env`；**只允许普通文件和目录，拒绝软链接、硬链接和设备文件**；使用 `O_EXCL` 创建文件，并去掉 setuid/setgid 位。
- **Schema 双向校验**：启动前用 inputSchema 校验 `input.json`；退出码为 0 后读取 `result.json`（≤ 1MiB），用 outputSchema 校验。`$ref` 只允许 `#` 开头的本地引用，防止 Schema 被用来做 SSRF 或读取文件。
- stdout/stderr 各自上限 1MiB，超出截断；超时判为 `timed_out`；先 `stop --time=2`，失败再 `kill`，最后一定执行 `rm --force`；通过 `inspect` 识别 OOM。
- Artifact 写入是原子的（临时文件 → fsync → rename），按内容寻址（`kind-<sha256>.bin`），读取时再次校验完整性，保留 30 天。
- `SANDBOX_RUNTIME=disabled` 时返回 `unavailable`，**不会退回到宿主机直接执行**。

---

## 5. 关键设计决策与取舍（面试主菜）

| 决策 | 选择 | 为什么 | 代价 |
|---|---|---|---|
| MCP 工具如何进入系统 | 适配成本地 `ToolDefinition`，而不是把 SDK 工具直接交给模型 | 确认、限流、超时、Trace、续跑都能复用；远端元数据不可信 | 每接一种新能力都要映射到本地策略 |
| MCP 连接生命周期 | 每次请求建立连接，结束即关闭 | 不需要管理长连接池；凭据和用户严格绑定；配置变更自然生效 | 每轮多一次握手和 `listTools`，延迟增加 |
| MCP 风险判定 | 默认一律需要确认，只有用户手动标记才免确认；忽略远端 hint | 远端可以谎报 `readOnlyHint` | 用户需要多点几次确认 |
| MCP 失败策略 | 不自动重试，写操作报告“状态未知” | 远端写操作不一定幂等，重试可能重复扣款、重复发消息 | 偶发网络抖动需要用户重新发起 |
| 确认状态存储 | Redis + 加密 + 单 key Lua 锁 | 请求是无状态的 HTTP；需要 TTL；需要原子领取 | 依赖 Redis；崩溃后记录卡在 BUSY 直到 TTL |
| 确认有效性 | 工具指纹（含配置 revision） | 防止“确认的是 A、执行的是被改过的 A'” | 配置一改，所有待确认的调用都失效 |
| Skill 工具形态 | 3 个固定工具 + 渐进式披露 | Skill 数量增加时 token 不膨胀 | 多一轮调用，模型需要学会先 list |
| Skill 版本 | 不可变版本 + 数据库触发器 + 哈希 CHECK | 可复现、可审计；Run 永远对应确定的代码 | 修 bug 只能发新版本 |
| 特权字段来源 | 只从已发布版本读，请求只带 input | 模型或前端被注入时也无法指定命令和镜像 | 灵活性低 |
| 沙盒执行器 | 独立 Go 服务 + Postgres 队列 + 容器 | 应用进程和不可信代码物理隔离；队列可以削峰；Worker 可横向扩展 | 多一个服务要部署和运维 |
| 队列实现 | Postgres `SKIP LOCKED` + lease + fencing | 不引入新中间件；与 Run 状态同库，可以放在同一事务里 | 吞吐量上限比专用 MQ 低（当前规模足够） |

---

## 6. 安全模型汇总（被问“安全怎么做”时按层回答）

| 层 | MCP | Skill |
|---|---|---|
| 身份 | 所有查询带 `user_id`；RLS + REVOKE；执行时再次核对 userId | HMAC 签名把 userId 绑进签名；Broker 核对 header 和 body；查询别人的 Run 返回 404 |
| 凭据 | AES-256-GCM 加密；列表不回显；换 URL 必须重填 | 模型接触不到凭据；Broker 密钥至少 32 字节 |
| 网络 | 仅公网 HTTPS、SSRF 检查、禁止重定向 | 容器 `--network=none`，数据库 CHECK 强制 disabled |
| 输入 | 本地 AJV 校验远端 Schema；Schema ≤ 32KB | 严格 JSON 解码；inputSchema 校验；`$ref` 只允许本地 |
| 权限 | 默认需要确认；忽略远端 hint；参数不可在确认时替换；指纹校验 | 只读根文件系统、`cap-drop ALL`、`no-new-privileges`、非 root、限制 pids/内存/CPU |
| 供应链 | 用户显式白名单 | 镜像按 digest 固定且 `--pull=never`；bundle 哈希由数据库校验；版本不可变 |
| 输出 | 16K 截断；非文本块不透传；不作为可信证据 | 日志各 1MiB；结果 1MiB 并经 outputSchema 校验；属于 `action_receipt` |
| 可靠性 | at-most-once；崩溃后不释放锁 | lease + fencing；确定性错误不重试；最多 3 次后置为 dead |

**Prompt 注入怎么防？** 远端工具的描述、返回文本和 `SKILL.md` 都是外部内容，模型可能被它们诱导。防线不在模型本身，而在执行面：模型被诱导后最多只能“提议”调用，写操作要经过用户确认，而 Skill 的特权字段模型根本无法指定。

---

## 7. 已知缺口（诚实边界，被追问时主动说）

1. **HMAC 没有防重放**：只有 ±300 秒的时间窗口，没有 nonce 缓存。窗口内可以重放；POST 请求靠幂等键限制影响（重放只会拿回同一个 Run）。改进方向：在 Redis 里记录 `signature` 并设置 TTL = 窗口时长。
2. **没有在代码里强制 rootless**：容器运行时允许 podman 或 docker，代码没有检查 rootless，隔离强度依赖部署时的配置（部署文档要求 rootless Podman）。
3. **MCP 没有沙盒**：远端服务本身的行为不受控，只能靠确认和白名单。MCP 的 resources、prompts、sampling 能力没有接入，只接了 tools。
4. **MCP 每轮都重新连接和发现**：没有连接池，也没有发现结果缓存，服务多时首字延迟会增加。
5. **Skill 目录不区分管理员**：所有登录用户都能导入和发布（`canEdit: true`），多租户场景需要引入 RBAC。
6. **限流在进程内存里**：`toolRateLimitBuckets` 是进程内的 Map，多实例部署时不共享。
7. **Egress 白名单策略已实现但没接入执行**（`internal/egress/policy.go`）：当前 Skill 全部禁网。
8. **`run_skill` 同步轮询 20 秒**：长任务只能返回 `queued/running` 让模型转述，没有做到完成后异步回推到对话里。
9. **SQL 状态约束和 Go 状态机有微小差异**：SQL 的 CHECK 里没有 `accepted` 状态。Postgres 模式直接插入 `queued`，实际不受影响。

---

## 8. 高频追问与参考回答

**Q1：MCP 和 Function Calling 是什么关系？**
Function Calling 是模型 API 层“模型输出结构化调用意图”的能力；MCP 是“工具从哪来、怎么发现、怎么调用”的应用层协议。项目里 MCP 发现的工具最终还是被转成 Function Calling 的 schema 交给模型。两者是上下游关系，不是替代关系。

**Q2：为什么不直接用 SDK 返回的工具，而是要自己适配一层？**
三个原因：① 远端元数据不可信，风险等级必须由本地决定；② 需要复用 Router 的确认、限流、超时和 Trace；③ 工具名要满足模型厂商的格式要求并避免跨服务冲突。适配层就是信任边界。

**Q3：用户确认之后，你怎么保证执行的就是他看到的那个调用？**
参数取自服务端 checkpoint，前端只提交 token 和 callId；token 按用户存储且加密；再用工具指纹校验工具定义和配置版本没有变化；最后用 Lua 原子领取，防止并发重复执行。

**Q4：确认执行到一半服务挂了会怎样？**
执行前已经把 `safeToRelease` 置为 false，锁不会释放，记录停在 BUSY 状态，再次确认会提示“状态未知，请先核实”。这是有意选择 at-most-once：对外部写操作来说，重复执行比没执行更危险。代价是需要用户手动核实。

**Q5：为什么把锁标记和状态放在同一个 Redis key 里？**
如果分成两个 key，在 LRU 淘汰策略下可能只有锁被淘汰、状态还在，另一个请求就能再次领取并重放写操作。放在同一个 key 里，要么整条记录都在，要么整条都没了（过期后要求用户重新发起），不会出现半状态。

**Q6：MCP 服务很多时，每轮都重新连接不会很慢吗？**
会。当前的取舍是正确性优先：凭据和用户严格绑定，配置变更立即生效，不需要管理连接池。优化方向：① 按 `(userId, serverId, revision)` 缓存 `listTools` 结果，设置短 TTL；② 连接并发建立（已实现 `allSettled`）；③ 根据意图路由按需连接，只连接可能用到的服务。

**Q7：为什么 Skill 不做成每个 Skill 一个工具？**
token 和工具选择准确率问题。几十个 Skill 如果每个都生成一个工具 Schema，system prompt 会膨胀，模型选错工具的概率也会上升。渐进式披露只让模型先看到目录，需要时再加载。

**Q8：模型能不能通过 run_skill 执行任意代码？**
不能。它只能选择一个已发布、已启用的版本，并提供符合 inputSchema 的 input。命令、镜像、网络和资源限制全部来自版本和 Profile，Broker 和 Worker 各校验一次。能执行的代码就是发布时经过哈希固定的那个 bundle。

**Q9：怎么防止 tar 包路径穿越？**
先校验 bundle 的 SHA-256，再逐个条目检查：拒绝绝对路径和 `..`；只允许普通文件和目录，拒绝软链接和硬链接（软链接可以指向容器外）；用 `O_EXCL` 创建文件；去掉 setuid 位；限制条目数和解包后的总大小，防止 zip bomb。读取 `result.json` 时也会解析软链接并再次确认路径在工作目录内。

**Q10：Worker 挂了，任务会丢吗？会重复执行吗？**
不会丢：租约过期后，其他 Worker 可以通过 `claim` 重新领取。会不会重复：同一时刻只有持有有效 `lease_token` 的 Worker 能写结果（fencing）；但代码本身可能被执行多次，所以 Skill 要求是可重入的，这是 at-least-once 语义。确定性失败（Schema 错误）不重试，最多尝试 3 次后置为 dead。

**Q11：为什么用 Postgres 做队列，而不是 Redis 或 Kafka？**
Run 的状态本来就存在 Postgres 里，队列和状态放在一起就能在同一个事务里完成领取和状态迁移，状态机触发器也能兜底。`SKIP LOCKED` 足以支撑当前规模。以后需要高吞吐时，可以把投递部分换成 MQ，状态仍然保留在数据库里。

**Q12：`--network=none` 之后，Skill 需要联网怎么办？**
目前明确不支持，数据库 CHECK 约束强制 `network = 'disabled'`。代码里已经有一个 egress 策略校验器（只允许 HTTPS GET/HEAD、白名单域名、拒绝私网和元数据地址），下一步是做一个受控出网代理，容器只能访问这个代理。

**Q13：MCP 的 Token 为什么换 URL 就必须重填？**
防止凭据外带。如果只改 URL 而沿用旧 Token，攻击者（或者被劫持的会话）把 URL 改成自己的服务器，下次连接时就会把用户的 Bearer Token 发过去。禁止重定向也是出于同样的原因。

**Q14：MCP 工具返回的内容能直接当事实引用吗？**
不能。读操作的 `grounding` 是 `none`，写操作是 `action_receipt`。项目里只有经过 `EvidenceBundle` 校验的知识库和网页检索结果才属于 `cited_evidence`。远端工具返回的文本等同于外部输入。

**Q15：如果要支持 stdio 类型的 MCP 服务（比如本地文件系统 MCP）怎么做？**
不能在 Web 服务端直接拉起用户指定的进程，那等于远程代码执行。合理做法是把 stdio 服务作为一种 Skill 或受信镜像，放进 Sandbox Broker 的容器里运行，再由 Broker 以 HTTP 的形式暴露出来，这样就能复用现有的隔离能力。

**Q16：怎么测试这些东西？**
- MCP：`client.test.ts` 用本地 HTTP 服务测试连接、分页和超时；`user-config.test.ts` 测试校验和 Token 规则；`confirm-tool.test.ts` 测试指纹失效、重复确认和续跑；`confirmation-store.test.ts` 测试原子领取。
- Skill：Go 侧有 `hmac_test`、`state_machine_test`、`manifest_test`、`schema_test`、`workspace/manager_test`（路径穿越）、`worker_test`、`executor_test`。
- 边界：单元测试不能替代目标机器上的 rootless、cgroup、网络隔离验收，部署文档里单独列了验收步骤。

---

## 9. 代码索引（面试前快速翻）

| 主题 | 文件 |
|---|---|
| 工具抽象 / 注册 / 执行 | `lib/agent/tools/types.ts`、`registry.ts`、`tool-router.ts` |
| 聊天主流程集成 | `packages/application/src/chat/run-chat.ts` |
| MCP 端口与会话 | `packages/application/src/mcp/ports.ts`、`session.ts` |
| MCP 连接与发现 | `packages/infrastructure/src/mcp/client.ts` |
| MCP 配置存储 | `packages/infrastructure/src/mcp/user-config.ts`、`docs/schemas/migrations/20260913-user-mcp-servers.sql` |
| MCP 适配器 | `lib/agent/tools/mcp-adapter.ts` |
| 确认续跑 | `packages/application/src/mcp/continuation.ts`、`confirm-tool.ts`、`packages/infrastructure/src/mcp/confirmation-store.ts` |
| Skill 工具 | `lib/agent/tools/sandbox-skills.ts` |
| Skill 服务与客户端 | `lib/sandbox/skills.ts`、`standard-skill.ts`、`client.ts` |
| Skill 表结构 | `docs/schemas/migrations/20260904-sandbox-runtime.sql`、`20260905-skill-list-detail.sql` |
| Broker API / 认证 | `apps/sandbox-broker/internal/api/handler.go`、`middleware.go`、`internal/auth/hmac.go` |
| 状态机 / 队列 / Worker | `internal/domain/state_machine.go`、`internal/queue/postgres/queue.go`、`internal/worker/worker.go` |
| 容器执行 / 解包 | `internal/executor/container/executor.go`、`internal/runtime/cli/command.go`、`internal/workspace/manager.go` |
| 前端 | `apps/web/features/connections/components/mcp-center.tsx`、`apps/web/features/skills/components/skill-center.tsx`、`apps/web/features/chat/components/mcp-tool-call.tsx` |
