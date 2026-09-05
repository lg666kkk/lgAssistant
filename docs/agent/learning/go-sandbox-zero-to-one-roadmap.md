# 从零学习 Go 并建设 Sandbox Broker：16 周项目路线图

> 适用项目：`/Users/lg/Desktop/personal-assistant`
>
> 实践主线：`apps/sandbox-broker`
>
> 适合背景：熟悉 TypeScript、React、Next.js，但尚未系统学习 Go、Linux 进程隔离和容器安全。

## 1. 路线目标

这条路线不以“学完整本 Go 语法书”为目标，而是通过建设一个真实的 Sandbox Broker，逐步掌握：

- Go 基础语法、包、接口、错误处理和测试；
- `net/http`、`context.Context`、goroutine、channel 和并发控制；
- Linux 进程、信号、文件描述符、用户权限和资源限制；
- rootless Podman/Docker、只读文件系统、capability、seccomp 和 cgroup；
- 持久任务、状态机、幂等、lease、heartbeat、重试和 dead-letter；
- Skill Bundle、Coding Workspace、Patch Artifact 和审批边界；
- 日志、指标、Trace、安全测试和故障注入。

16 周结束时，目标不是声称“沙盒绝对安全”，而是交付一个边界清楚、可以验证以下性质的系统：

1. Next.js 不直接执行模型生成的命令。
2. 每个任务在独立、一次性容器中运行。
3. 超时和取消能够真正终止底层容器。
4. 默认断网，沙盒拿不到应用和数据库密钥。
5. CPU、内存、PID、磁盘和输出均有限额。
6. Worker 崩溃后任务能够通过 lease 被回收。
7. Skill 只能执行已发布的固定版本入口。
8. Coding Agent 只能生成 Patch，不能直接修改宿主仓库。
9. 一次执行可以通过 `runId` 还原状态、事件、资源和产物。

## 2. 当前起点

项目已经初始化了 Go Module：

```text
apps/sandbox-broker/
├── cmd/broker/main.go
├── internal/api/handler.go
├── internal/config/config.go
├── internal/domain/run.go
├── internal/executor/executor.go
├── internal/policy/profile.go
└── README.md
```

当前已经具备：

- HTTP 服务和优雅退出；
- `/healthz`、`/v1/profiles`、`/v1/runs`、取消接口；
- `ExecuteRequest`、`ExecuteResult`；
- `skill-trusted` 和 `coding-untrusted` Profile；
- `Executor` 接口；
- 请求、Profile 和 Handler 单元测试；
- 显式禁用的 `DisabledExecutor`。

当前还不具备：

- 真实容器执行；
- 持久 Run 状态机；
- Worker、lease 和 heartbeat；
- stdout/stderr 事件流；
- Artifact 对象存储；
- Skill Manifest 和不可变版本；
- Coding Workspace 和 Patch 应用流程；
- 网络代理、凭证代理和生产鉴权。

这里的 `501 Not Implemented` 是正确状态。它代表系统还没有建立隔离边界，而不是功能失败。

## 3. 学习方式

### 3.1 时间投入

标准节奏：每周 8-10 小时，共 16 周。

```text
阅读与小实验       2 小时
项目实现           4 小时
测试与故障注入     2 小时
复盘与文档         1 小时
```

如果每周只能投入 4-5 小时，把每一周拆成两周，不要删除测试和复盘。

### 3.2 每次学习循环

每个知识点使用同一个闭环：

```text
先定位项目问题
    ↓
学习最少必要知识
    ↓
写一个很小的实验
    ↓
接入正式接口
    ↓
写正常测试和失败测试
    ↓
记录边界与剩余风险
```

不要先连续看几十小时课程。Go 的语法不难，真正需要通过项目建立的是：生命周期、取消、并发、资源所有权和错误语义。

### 3.3 每周完成定义

每周任务只有同时满足以下条件才算完成：

- 实现代码已提交到明确模块；
- `gofmt`、`go test ./...`、`go vet ./...` 通过；
- 至少一个失败路径测试通过；
- 能用自己的话解释该周核心机制；
- README 或设计文档记录了当前保证和未保证内容。

## 4. TypeScript 到 Go 的概念映射

| TypeScript / Node.js | Go | 本项目落点 |
|---|---|---|
| `type` / `interface` | `struct` / `interface` | `internal/domain/run.go`、`internal/executor/executor.go` |
| `Promise<T>` | 函数返回值和 goroutine | Executor、Worker |
| `throw/catch` | `error` 返回值、`errors.Is` | API 错误映射 |
| `AbortController` | `context.Context` | 超时、取消、HTTP 断开 |
| Express/Next Route | `net/http` Handler | `internal/api/handler.go` |
| Middleware | `func(http.Handler) http.Handler` | 鉴权、日志、request ID |
| class dependency | 小接口 + 构造函数注入 | `Executor`、`RunStore`、`ArtifactStore` |
| `Map` | `map[K]V` | Profile Registry、运行中任务表 |
| event emitter | channel / 持久事件表 | stdout/stderr、状态事件 |
| `Promise.all` | goroutine + `errgroup` 或 `WaitGroup` | 并行 Artifact 上传等 |
| `Promise.race` 超时 | `context.WithTimeout` + 真正 kill | 容器生命周期 |
| Jest/Vitest table cases | table-driven tests | `*_test.go` |
| npm workspace | Go Module / `go work` | `apps/sandbox-broker/go.mod` |

关键差异：

- Go 接口通常由使用方定义，接口应当小。
- `context.Context` 不保存业务数据，主要传递取消、截止时间和 request scope。
- goroutine 很轻，但不是免费的；启动 goroutine 后必须知道它如何结束。
- channel 适合协调，不应替代所有共享状态；持久任务状态必须写数据库。
- `defer` 很适合资源清理，但要理解执行时机和循环内使用的成本。

## 5. 目标架构

```text
Browser / Agent UI
        |
        v
Next.js Agent Runtime
        |
        v
Tool Gateway
鉴权 / 策略 / 审批 / 参数哈希 / 配额
        |
        v
Go Sandbox Broker
创建 Run / 查询 / 取消 / 事件订阅
        |
        v
PostgreSQL Queue
状态 / lease / heartbeat / retry / dead
        |
        v
Go Sandbox Worker
准备 Workspace / 启动容器 / 采集输出 / 清理
        |
        v
rootless Podman + gVisor（后期）
        |
        +--> Skill Sandbox
        +--> Coding Sandbox
        |
        +--> Artifact Storage
        +--> Egress Proxy
```

控制面和数据面必须分开：

- Broker 是控制面，负责认证、策略、状态和调度。
- Worker 是执行控制器，负责容器生命周期。
- 沙盒容器是数据面，只处理最小输入并产生受限输出。
- Next.js 不能持有容器 Socket。
- 沙盒容器不能持有应用、数据库和模型密钥。

## 6. 16 周路线总览

| 阶段 | 周数 | Go 主知识 | Sandbox 交付物 |
|---|---:|---|---|
| A. Go 入门 | 1-2 | 语法、包、struct、interface、error、测试 | 理解并改造现有骨架 |
| B. 服务端基础 | 3-4 | HTTP、Context、并发、信号、进程 | 可观测 API、学习型进程 Runner |
| C. 容器执行 | 5-7 | 接口设计、命令适配、资源清理 | rootless Podman Executor |
| D. 持久运行时 | 8-10 | 数据库、状态机、Worker、lease | 异步 Run、取消、崩溃恢复 |
| E. Skill | 11-12 | JSON Schema、版本、哈希、供应链 | 固定入口的 Skill Sandbox |
| F. Coding Agent | 13-14 | Workspace、Git、Artifact | 隔离修改、测试、Patch 审批 |
| G. 生产硬化 | 15-16 | 网络安全、观测、压测、威胁建模 | Egress、指标、安全演示 |

---

## 7. 第一阶段：Go 入门

### 第 1 周：读懂当前 Go 项目

#### Go 知识

- `package`、`import`、导出标识符；
- 基础类型、slice、map；
- `struct` 和方法；
- 多返回值；
- `if err != nil`；
- JSON tag；
- `gofmt`、`go test`、`go vet`。

#### 对照代码

- `internal/domain/run.go`
- `internal/policy/profile.go`
- `internal/config/config.go`

逐行回答：

1. 为什么 `ExecuteRequest.Validate()` 返回 `error`，而不是抛异常？
2. 为什么 `Profile` 是值类型？
3. 为什么 Profile Registry 对外返回排序后的 slice？
4. JSON tag 如何影响 HTTP 响应？
5. `RunStatus` 为什么使用自定义字符串类型？

#### 实现任务

- 为 `ExecuteRequest.Validate()` 增加：
  - `runId` 最大长度；
  - `idempotencyKey` 最大长度；
  - 单个命令参数最大长度；
  - `timeoutSeconds` 非负校验。
- 使用 table-driven test 覆盖每个边界。

#### 完成标准

- 能独立新增一个字段及 JSON 编解码测试。
- 能解释值接收者和指针接收者的区别。
- 能在不看教程的情况下运行：

```bash
go test ./...
go test ./internal/domain -run TestExecuteRequestValidate -v
go vet ./...
```

### 第 2 周：接口、依赖注入与错误模型

#### Go 知识

- 隐式实现 interface；
- 小接口原则；
- 构造函数模式；
- sentinel error 与 `errors.Is`；
- error wrapping：`fmt.Errorf("...: %w", err)`；
- fake、stub、recording test double。

#### 对照代码

- `internal/executor/executor.go`
- `internal/api/handler_test.go`

#### 实现任务

新增小接口：

```go
type RunStore interface {
    Create(ctx context.Context, run domain.Run) (stored domain.Run, created bool, err error)
    Get(ctx context.Context, runID string) (domain.Run, error)
}
```

先实现内存版，仅用于学习和单元测试：

```text
internal/store/memory/run_store.go
```

要求：

- 重复 `idempotencyKey` 返回同一个 Run；
- 未找到使用稳定的 `ErrRunNotFound`；
- 并发读写使用 `sync.RWMutex`；
- 测试使用 `go test -race ./...`。

#### 完成标准

- 能解释为什么 Handler 不应依赖具体数据库实现。
- 能解释 `Executor` 为什么比一个巨大的 `SandboxService` 接口更容易测试。
- Race Detector 不报告数据竞争。

---

## 8. 第二阶段：Go 服务端与进程基础

### 第 3 周：HTTP、Context 与服务生命周期

#### Go 知识

- `net/http` Server、Handler、ServeMux；
- 请求 Body 限制；
- middleware；
- `context.WithTimeout`；
- 信号和 graceful shutdown；
- HTTP 错误码与领域错误映射。

#### 对照代码

- `cmd/broker/main.go`
- `internal/api/handler.go`

#### 实现任务

- 增加 `request_id` middleware。
- 增加内部 API HMAC 验证接口，但开发环境可显式关闭。
- 增加 `GET /v1/runs/{runID}`。
- 为 Handler 增加状态码记录，当前日志 middleware 只能记录方法和路径。
- 为 Body 超限、未知字段、错误 Content-Type、请求取消写测试。

#### 完成标准

- 客户端断开后 `request.Context().Done()` 能被观察到。
- 服务收到 SIGTERM 后停止接新请求并在截止时间内退出。
- 日志包含 `requestId`、method、path、status、duration。

### 第 4 周：goroutine、channel 与 OS 进程

#### Go 知识

- goroutine 生命周期；
- unbuffered/buffered channel；
- `select`；
- `sync.WaitGroup`、`Mutex`、`Once`；
- `os/exec.Cmd`；
- stdin/stdout/stderr pipe；
- Unix signal 和进程组。

#### 学习实验

实现一个仅在测试和本地实验中使用的 `ProcessExecutor`：

```text
internal/executor/process/process.go
```

它必须：

- 使用 `exec.CommandContext`；
- 分开采集 stdout/stderr；
- 限制输出字节数；
- 超时后终止整个进程组；
- 返回 exit code、timedOut 和 duration。

#### 安全限制

这个执行器是为了学习 Go 进程 API，不是生产沙盒：

- 不注册到公开 HTTP Handler；
- 不允许 Next.js 调用；
- 使用 build tag 或显式 `SANDBOX_PROCESS_EXECUTOR_FOR_TESTS=true`；
- README 标记“不提供文件、网络、用户或 syscall 隔离”。

#### 故障测试

- `sleep` 超时；
- 无限输出被截断；
- 子进程再启动子进程后仍能整体终止；
- 非零退出码；
- Context 提前取消；
- 并发执行 20 个任务无泄漏。

#### 完成标准

能够明确解释：

> `exec.CommandContext` 解决进程取消，不等于沙盒；真正的安全边界仍需要容器、挂载、网络和资源控制。

---

## 9. 第三阶段：容器执行面

### 第 5 周：Linux 和容器安全基础

#### 学习主题

- process、PID、进程组、signal；
- UID/GID 与文件权限；
- namespace；
- cgroup；
- Linux capability；
- seccomp；
- mount、bind mount、tmpfs；
- rootless 容器的保证和限制。

#### 实验清单

先在命令行手工运行一个最小容器，逐项验证：

- 非 root 用户；
- `--read-only`；
- `--network=none`；
- `--cap-drop=ALL`；
- `--security-opt=no-new-privileges`；
- `--pids-limit`；
- `--memory`；
- `--cpus`；
- 受限 tmpfs；
- 仅挂载临时 Workspace。

每加一项参数，都写下它防什么、不防什么。不要直接复制一条长命令后声称完成。

#### 完成标准

- 能解释部署 App 容器与一次性执行沙盒的区别。
- 能回答“恶意代码在容器中执行时最坏能得到什么”。
- 能验证沙盒看不到项目 `.env.local`。

### 第 6 周：Runtime 接口和 Podman 命令构造

#### Go 知识

- Adapter Pattern；
- 纯函数构造参数；
- 临时目录和 `defer` 清理；
- path 清理和软链接风险；
- SHA-256 与不可变镜像标识。

#### 实现结构

```text
internal/runtime/runtime.go
internal/runtime/podman/client.go
internal/runtime/podman/command.go
internal/workspace/manager.go
```

建议接口：

```go
type Runtime interface {
    Create(ctx context.Context, spec ContainerSpec) (Container, error)
    Start(ctx context.Context, id string) error
    Wait(ctx context.Context, id string) (ExitResult, error)
    Kill(ctx context.Context, id string) error
    Remove(ctx context.Context, id string) error
}
```

Broker 调用方不能直接构造 `ContainerSpec`。只有 Policy Resolver 可以把 `profileId` 转成内部 Spec。

#### 实现任务

- 先实现 `BuildRunArguments(spec)` 纯函数。
- 对每个安全参数写精确断言测试。
- 拒绝非 digest 镜像。
- 拒绝 Workspace 根目录、Home、`/`、相对路径和软链接逃逸。
- 容器命名只使用经过规范化的 `runId`。

#### 完成标准

- 模型不能通过请求字段覆盖 `--network`、mount、capability 或镜像。
- 对同一个 Profile，容器参数是确定性的。
- 安全参数缺少任意一个时测试失败。

### 第 7 周：真正可终止的 Podman Executor

#### 实现任务

- 用 Runtime Adapter 替换 `DisabledExecutor`，但通过配置显式启用。
- 一次 Run 创建一个容器，用完即毁。
- 容器必须包含标签：
  - `sandbox.run_id`；
  - `sandbox.profile_id`；
  - `sandbox.worker_id`。
- 使用 `context.WithTimeout` 驱动：
  - 正常等待；
  - `podman stop --time 2`；
  - 仍未退出则 `podman kill`；
  - 最后 `podman rm --force`。
- Broker 启动时扫描并清理过期孤儿容器。

#### 安全测试

- 无限循环在超时后不再存在。
- 内存炸弹触发 OOM，Broker 仍正常。
- Fork Bomb 被 PID 限制。
- `/workspace` 之外不可写。
- 无法访问宿主 Home 和应用目录。
- 无法访问公网、localhost 和 Redis。

#### 完成标准

不能只看到 API 返回 `timedOut=true`；必须额外查询容器运行时，证明对应容器和子进程已经消失。

---

## 10. 第四阶段：持久 Run 和可靠 Worker

### 第 8 周：领域状态机与数据库设计

#### Go 知识

- 领域状态和合法迁移；
- repository 接口；
- PostgreSQL 事务；
- 乐观/悲观并发；
- 数据库错误分类。

#### 状态机

```text
queued -> preparing -> running -> collecting_artifacts -> completed
   |          |           |               |
   +----------+-----------+---------------+--> failed
                          +------------------> timed_out
                          +------------------> cancelled
queued/running -> retry_wait -> queued -> dead
```

#### 数据表

新增迁移：

```text
docs/schemas/migrations/YYYYMMDD-sandbox-runs.sql
```

至少包含：

- `sandbox_runs`；
- `sandbox_events`；
- `sandbox_artifacts`；
- `sandbox_approval_grants`。

关键字段：

```text
id, user_id, session_id, request_id, tool_call_id
kind, profile_id, profile_version
idempotency_key, input_hash, status, attempts
worker_id, lease_token, lease_until, next_attempt_at
cancel_requested_at, started_at, completed_at
image_digest, exit_code, timed_out, oom_killed
error_code, error_message, created_at, updated_at
```

#### 完成标准

- 非法状态迁移在 Go 和数据库两层都被拒绝。
- `(user_id, idempotency_key)` 唯一。
- Run 状态是事实来源，Trace 只是观测投影。

### 第 9 周：Worker、claim、lease 和 heartbeat

#### Go 知识

- 长运行进程；
- ticker；
- Worker Pool；
- 有界并发；
- Context 树；
- shutdown 顺序。

#### 实现结构

```text
cmd/worker/main.go
internal/queue/postgres.go
internal/worker/worker.go
internal/worker/heartbeat.go
```

#### 可靠性规则

- 使用 `FOR UPDATE SKIP LOCKED` 原子 claim。
- claim 时写入 `worker_id`、随机 `lease_token`、`lease_until`。
- Worker 定期 heartbeat 续租。
- ACK/失败更新必须匹配：

```text
id + worker_id + lease_token + status=running
```

- 旧 Worker 丢失 lease 后不得更新终态。
- 同一 Worker 同时执行数必须有上限。

#### 参考实现

复用项目现有 RAG ingestion queue 的可靠性语义，不复制业务代码：

- `lib/knowledge/ingestion-queue.ts`
- `docs/schemas/migrations/20260717-rag-ingestion-production.sql`

#### 故障测试

- Worker claim 后被 kill；
- lease 过期后新 Worker 接管；
- 旧 Worker 恢复并尝试写 completed；
- 两个 Worker 并发 claim；
- 数据库短暂失败；
- 达到最大 attempts 后进入 dead。

### 第 10 周：事件、取消和 Artifact

#### Go 知识

- 流式读写；
- scanner 的 token 限制；
- backpressure；
- append-only event；
- 对象存储接口；
- 内容哈希和完整性。

#### 实现任务

- stdout/stderr 分块写入 `sandbox_events`。
- 每个 Run 使用严格递增 `sequence`。
- 增加 `GET /v1/runs/{id}/events?after=sequence`。
- 取消请求只先写 `cancel_requested_at`，Worker 负责终止实际容器。
- Artifact 增加 `sha256`、size、content type、retention。
- 输出给模型前经过截断、DLP 和“不可信数据”标记。

#### 输出限制

建议第一版：

```text
stdout 最大保存 1 MiB
stderr 最大保存 1 MiB
单行最大 64 KiB
单 Artifact 最大 10 MiB
单 Run Artifact 总量最大 50 MiB
```

#### 完成标准

- 页面断线后可以按 sequence 继续读取事件。
- 无限输出不会压垮 Broker、数据库或模型上下文。
- 取消请求能在限定时间内终止容器并落 `cancelled` 终态。

---

## 11. 第五阶段：Skill 执行

### 第 11 周：Skill Manifest 和版本模型

#### Go 知识

- JSON 编解码和自定义校验；
- `embed`；
- 文件遍历；
- tar/zip 安全解包；
- hash、签名和版本。

#### Skill Bundle

```text
skills/example/
├── SKILL.md
├── skill.json
├── scripts/
│   └── run.mjs
└── schemas/
    ├── input.json
    └── output.json
```

Manifest 决定：

- 固定 runtime；
- 固定 entrypoint；
- Profile；
- 最大资源；
- 是否需要网络；
- 输入/输出 Schema；
- Bundle digest。

#### 不变量

- Agent 只能提交 `skillId + version + input`。
- Agent 不能提交 Skill 的实际 command。
- 发布后 Bundle 不可变。
- Worker 校验实际 SHA-256 与记录一致。
- 解包拒绝绝对路径、`..` 和软链接逃逸。

### 第 12 周：第一个真实 Skill

选择一个完全离线、确定性强的 Skill，例如：

- Markdown 结构检查；
- JSON/CSV 数据转换；
- TypeScript AST 统计；
- LeetCode 测试用例执行器。

暂时不要选择：

- 需要 OAuth 的服务；
- 需要任意公网访问的爬虫；
- 自动安装未知依赖；
- 写生产数据库的脚本。

#### 端到端链路

```text
run_skill Tool
  -> Tool Gateway
  -> approval/input hash
  -> Broker create Run
  -> Worker
  -> Skill Sandbox
  -> result.json
  -> Artifact
  -> ToolResult
  -> Agent Trace
```

#### 完成标准

- 同一幂等键不会重复执行。
- 修改输入后旧审批不可用。
- Skill 无法读取应用密钥。
- Skill 输出通过 Schema 校验后才标记 completed。

---

## 12. 第六阶段：Coding Agent

### 第 13 周：隔离 Workspace

#### 学习主题

- Git tree、index、worktree 和 patch；
- tar/git bundle；
- 文件权限；
- 内容寻址快照；
- 大文件和软链接边界。

#### 数据流

```text
可信应用生成源码快照
       ↓
Object Storage
       ↓
Worker 下载到临时目录
       ↓
容器挂载 /workspace
       ↓
Coding Agent 修改和测试
       ↓
生成 git diff --binary
       ↓
Patch Artifact
```

禁止直接把宿主仓库以可写方式挂进容器。

#### 实现任务

- `WorkspaceManager.Prepare(snapshotRef)`；
- 校验大小、文件数、路径和 digest；
- 创建独立 Git 仓库基线；
- 执行完成后生成 patch、changed files 和 test report；
- 无论成功失败都清理临时目录。

### 第 14 周：Patch 审批与应用

沙盒只负责提出修改：

```text
proposed -> approved -> applying -> applied
                  |          |
                  +----------+-> apply_failed
```

真正应用 Patch 的逻辑属于可信应用路径，不属于沙盒 Worker。

#### 必须校验

- Patch 基线 commit 与当前仓库一致，或者显式三方合并。
- 修改路径在允许范围。
- 不允许改 `.git`、密钥、部署凭据和 Broker 策略。
- Patch 哈希与用户批准的哈希一致。
- 审批只能消费一次。
- 应用后重新执行可信侧检查。

#### 完成标准

- Coding Run 不经确认无法改变宿主仓库。
- 修改 Patch 任意一个字节后原审批失效。
- Patch 冲突不会被静默覆盖。

---

## 13. 第七阶段：网络、观测与生产硬化

### 第 15 周：Egress Proxy 与凭证边界

默认保持 `network=disabled`。需要联网的 Skill 使用独立 Egress Proxy：

```text
Sandbox -> Egress Proxy -> Approved Public Endpoint
```

Proxy 必须实现：

- 域名白名单；
- DNS 解析后 IP 校验；
- 拒绝 loopback、私网、link-local 和云元数据地址；
- 每次重定向重新校验；
- 请求/响应大小限制；
- 方法限制；
- 超时和连接数限制；
- 出网审计。

沙盒不直接获得 OAuth Refresh Token。需要外部服务时，通过 Credential Proxy 使用绑定 `runId + action + resource + expiry` 的短期 capability token。

#### 安全测试

- `localhost`；
- `127.0.0.1`、`::1`；
- RFC1918 私网；
- `169.254.169.254`；
- 域名解析到私网；
- 公网 URL 重定向到私网；
- 超大响应；
- 未授权 HTTP 方法。

### 第 16 周：观测、压测、威胁建模与演示

#### 指标

- queue duration P50/P95；
- container startup P95；
- execution duration；
- completion、failure、timeout、OOM 比率；
- cancel latency；
- lease lost；
- orphan containers；
- stdout/stderr bytes 和 truncated 比率；
- Artifact 上传失败率；
- 每用户 CPU seconds、memory seconds。

#### Trace 字段

```text
sandboxRunId
profileId / profileVersion
imageDigest
workerId
queueDurationMs
prepareDurationMs
executionDurationMs
exitCode
timedOut / oomKilled
stdoutBytes / stderrBytes
artifactRefs
```

#### 最终故障演示

准备一套可重复执行的演示：

1. 无限循环被真正终止。
2. Fork Bomb 被 PID 限制。
3. 内存炸弹只杀死沙盒任务。
4. 沙盒读取应用 `.env` 失败。
5. 沙盒访问 Redis 和云元数据失败。
6. Worker 执行中被杀后，任务 lease 过期并恢复。
7. 旧 Worker 无法覆盖新 Worker 终态。
8. 无限 stdout 被截断但 Broker 存活。
9. 同一幂等键不会产生两个执行。
10. 未批准 Patch 无法写回宿主仓库。

#### 最终文档

- 架构图；
- Run 状态机；
- 一次执行时序图；
- 威胁模型；
- Profile 安全矩阵；
- API 契约；
- 故障注入报告；
- 压测报告；
- 部署和回滚说明；
- 已实现、原型、路线图能力表。

## 14. 推荐的 Go 目录演进

```text
apps/sandbox-broker/
├── cmd/
│   ├── broker/main.go
│   └── worker/main.go
├── internal/
│   ├── api/
│   │   ├── handler.go
│   │   ├── middleware.go
│   │   └── errors.go
│   ├── approval/
│   ├── artifact/
│   ├── auth/
│   ├── config/
│   ├── domain/
│   │   ├── run.go
│   │   ├── event.go
│   │   └── state_machine.go
│   ├── policy/
│   ├── queue/
│   │   └── postgres.go
│   ├── runtime/
│   │   ├── runtime.go
│   │   └── podman/
│   ├── skill/
│   ├── store/
│   ├── worker/
│   └── workspace/
├── migrations/
├── testdata/
├── Dockerfile
├── go.mod
└── README.md
```

目录不是一次性建完。只有当一个包拥有独立职责和测试时才创建它。

## 15. 学习资源顺序

只建议围绕当前阶段查资料：

1. Go Tour：语法、slice、map、method、interface、goroutine。
2. Effective Go：命名、接口、错误、并发习惯。
3. Go Blog：Context、Pipelines、Error handling。
4. 标准库文档：`net/http`、`context`、`os/exec`、`io`、`sync`、`testing`。
5. Linux 手册：`signal(7)`、`namespaces(7)`、`capabilities(7)`、`seccomp(2)`、`cgroups(7)`。
6. Podman rootless、security、resource limits 官方文档。
7. gVisor 官方架构和安全模型。

每周最多选择一套主资料。遇到项目问题再查对应标准库文档，不需要完整记忆 API。

## 16. 每日练习模板

一次 60-90 分钟的学习可以这样安排：

```text
10 分钟  回顾昨天的一个概念
20 分钟  阅读标准库或写最小实验
35 分钟  修改 Sandbox Broker
15 分钟  补测试并制造一个失败
10 分钟  写下“保证什么、不保证什么”
```

每次只提交一个可以说清楚的变化，例如：

- 为请求增加一个校验；
- 为 Handler 增加一个中间件；
- 为进程增加真正的取消；
- 为 Profile 增加一个安全不变量测试；
- 为 Worker 增加一次 heartbeat；
- 为 Artifact 增加 digest 校验。

## 17. 阶段性自测问题

### Go 基础阶段

- slice 和 array 有什么区别？
- interface 为什么不需要显式 `implements`？
- `errors.Is` 与字符串比较有什么区别？
- 哪些场景应该用指针接收者？
- goroutine 如何结束，谁负责等待它？

### 容器执行阶段

- `context.WithTimeout` 为什么仍不能单独构成沙盒？
- `--read-only` 后为什么还需要限制 mount？
- rootless 容器解决了什么，没有解决什么？
- 为什么应用容器不能拿 Docker Socket？
- 为什么镜像必须使用 digest？

### 持久 Worker 阶段

- Snapshot 和 durable Run 有什么区别？
- lease 为什么需要 heartbeat？
- 为什么 ACK 要校验 worker 和 lease token？
- at-least-once 为什么仍需要业务幂等？
- 哪些失败可以重试，哪些不应自动重试？

### Skill/Coding 阶段

- Skill 为什么不能由模型提交任意 command？
- 沙盒为什么不直接拿 OAuth Token？
- 为什么 Coding Agent 只返回 Patch？
- Patch 审批应绑定哪些字段？
- 沙盒输出为什么仍是不可信数据？

## 18. 不应提前做的事情

在单机版本没有通过安全测试前，不要提前引入：

- Kubernetes；
- Firecracker；
- 多区域 Worker；
- 自研容器运行时；
- 动态下载任意镜像；
- 任意公网访问；
- 自动安装无锁定依赖；
- 多 Agent 并行修改同一 Workspace；
- “完全安全”或“企业级”的宣传。

这些技术不是没有价值，而是会遮蔽当前最需要学习的执行生命周期和安全不变量。

## 19. 前 14 天具体行动

### 第 1-2 天

- 完成 Go Tour 的基础类型、函数、slice、map。
- 逐行阅读 `internal/domain/run.go`。
- 手写一遍 `ExecuteRequest.Validate()`，再和当前实现比较。

### 第 3-4 天

- 学习 struct、method、pointer receiver。
- 给请求增加长度限制。
- 写 table-driven tests。

### 第 5-6 天

- 学习 interface 和隐式实现。
- 阅读 `Executor` 与 `DisabledExecutor`。
- 写一个 fake Executor 并在 Handler 测试中注入。

### 第 7 天

- 运行 `go test -race ./...`。
- 总结第一周：请求从 HTTP 进入后经过哪些类型和接口。

### 第 8-9 天

- 学习 error wrapping 和 `errors.Is`。
- 定义 `ErrRunNotFound`、`ErrDuplicateRun`。
- 为错误到 HTTP 状态码的映射写测试。

### 第 10-11 天

- 学习 map、Mutex、RWMutex。
- 实现内存 `RunStore`。
- 写 20 个 goroutine 并发访问测试。

### 第 12-13 天

- 学习 `context.Context`。
- 为 Store 方法增加 Context。
- 测试已取消 Context 不继续工作。

### 第 14 天

- 画出当前 Broker 的调用图。
- 写一页复盘：Go 和 TypeScript 在错误、接口、异步上的区别。
- 确认所有测试、vet 和 race test 通过。

## 20. 最终作品集表达

只有完成并有测试证据后，才可以这样描述：

> 使用 Go 构建独立 Sandbox Broker 和可恢复 Worker，通过 rootless 容器、只读文件系统、默认断网、cgroup 资源限制和不可变执行 Profile 隔离 Skill 与模型生成代码；使用 PostgreSQL claim/lease/heartbeat 实现崩溃恢复，通过参数哈希和一次性审批保护 Coding Patch 应用，并将执行事件、资源使用和 Artifact 接入 Agent Trace。

需要同时展示证据：

- 架构和威胁模型；
- 关键接口和状态机；
- 正常路径测试；
- 无限循环、OOM、越权访问、Worker Crash 等故障演示；
- 指标和 Trace 截图；
- 明确列出的剩余风险。

## 21. 当前第一步

从第 1 周任务开始，不要直接实现 Podman Executor。第一个实际提交应是：

1. 收紧 `ExecuteRequest` 长度和参数校验；
2. 给校验补齐 table-driven tests；
3. 增加内存 `RunStore` 接口和实现；
4. 用 Race Detector 验证并发安全；
5. 写一页 TypeScript 到 Go 的错误与接口对照笔记。

完成这一步后，你会掌握 Go 最核心的 struct、method、interface、error、map、mutex 和 test，同时不会在尚未理解生命周期时直接操作容器权限。
