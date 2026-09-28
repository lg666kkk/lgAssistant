# 沙盒方案比较

更新日期：2026-09-28

本文比较当前项目可选的代码执行沙盒，重点关注 AI 生成代码、Skill 运行、命令执行、文件读写和网络控制。价格是架构选型用的区间，不是供应商报价；云资源价格会随地域、计费方式、流量和并发变化。

## 结论先看

| 方案 | 形态 | 隔离能力 | 接入难度 | 费用形态 | 最适合的场景 |
| --- | --- | --- | --- | --- | --- |
| E2B | 托管云沙盒 | 高，平台代管 | 低 | 按量/套餐，可能要求项目验证 | 快速上线、短时 Skill |
| OpenSandbox | 开源平台，可自托管 | 可选 Docker、gVisor、Kata、Firecracker | 中高 | 软件免费，自己承担云资源和运维 | 国内部署、希望保留控制权 |
| Modal Sandbox | 托管云运行时 | 中高，按平台能力 | 中 | 按资源和运行时间 | 云端 Python、容器任务 |
| Daytona | 开源/托管开发环境 | 取决于运行时配置 | 中 | 云资源或托管服务费用 | 长生命周期工作区、编码 Agent |
| Docker/Podman | 自建容器 | 中低，取决于加固 | 低 | 服务器成本 | 本地开发、可信任务 |
| Firecracker/Kata/gVisor 自建 | 底层隔离运行时 | 高 | 高 | 节点、网络和运维成本 | 生产级不可信代码执行 |
| 云厂商代码解释器 | 托管工具 | 通常只覆盖受限 Python | 低 | 按调用或平台套餐 | 数据分析、文件处理 |

## 方案详情

### E2B

**优点**

- API 和 SDK 面向 AI Agent 设计，创建、执行、读写文件和销毁流程简单。
- 不需要自己维护节点、镜像调度、隔离运行时和清理任务。
- 适合当前项目的短时 Skill：上传 Bundle，执行固定入口，读取 `result.json`，销毁 Sandbox。

**缺点**

- 运行、地区、网络出口和模板能力受供应商控制。
- 新项目可能触发银行卡验证；免费 Hobby 计划不等于所有项目都免验证。
- 需要保存 E2B API Key，供应商故障或账户限制会直接影响执行。
- 长时间任务、复杂队列和自定义安全策略仍要在应用侧实现。

**当前项目迁移成本**：最低。现有 `lib/sandbox/client.ts` 直接使用 E2B SDK，数据库和文档也以 E2B 模板 ID、Sandbox ID 为字段。

### OpenSandbox

项目地址：[opensandbox-group/OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)

**优点**

- 面向 AI 代码执行、Coding Agent、浏览器自动化和评测场景。
- 提供 Python、TypeScript、Go 等 SDK，以及 CLI 和 MCP Server。
- 支持 Docker、Kubernetes，并可使用 gVisor、Kata Containers 或 Firecracker。
- 有文件系统、命令执行、代码解释器、网络策略和凭证注入等平台能力。
- 可以部署在腾讯云、阿里云或本地，避免被单一托管服务锁定。

**缺点**

- 软件免费不代表总成本低，需要维护节点、镜像、调度、日志、网络和清理。
- 如果使用 Firecracker、Kata 或 Kubernetes，需要较强的容器和集群运维能力。
- 安全性取决于实际启用的运行时和策略；只部署普通 Docker 不能自动获得强隔离。
- 项目版本、运行时兼容性和生产稳定性需要自己验证。

**当前项目迁移成本**：中高。建议保留现有 `ToolDefinition`、Run 状态、Bundle 校验和结果协议，只替换 E2B 客户端为 OpenSandbox Adapter。数据库中的 `e2b_template_id`、`e2b_sandbox_id` 应改成供应商无关的 `runtime_template_id`、`runtime_sandbox_id`，或者增加兼容字段。

### Modal Sandbox

**优点**

- 适合云端 Python、容器和短时计算任务。
- 不需要自己搭建 Kubernetes，按实际资源使用计费。
- 对数据处理、模型辅助代码执行和批量任务比较方便。

**缺点**

- 产品抽象更偏云函数/计算任务，不一定覆盖 E2B 的完整工作区体验。
- 需要核实命令执行、持久文件、浏览器、网络策略和超时语义是否满足当前 Skill 合约。
- 国内网络、账号、区域和数据合规要求需要单独确认。

**当前项目迁移成本**：中等。固定入口和 `input.json`/`result.json` 协议可以复用，但 Sandbox 生命周期、文件 API、取消语义和错误映射需要重写。

### Daytona

**优点**

- 更接近完整远程开发环境，适合 Coding Agent、终端、文件系统和长生命周期工作区。
- 可以自托管，环境和依赖的控制力比纯托管 API 更强。
- 对需要保留工作区状态、反复执行命令的任务比较合适。

**缺点**

- 它更像开发环境平台，不是只为短时一次性函数设计的 E2B 替代品。
- 隔离强度取决于底层运行时、节点策略和部署方式，不能只看 SDK 名称。
- 运行中的工作区、磁盘和节点会产生持续成本。

**当前项目迁移成本**：中等偏高。需要重新定义 Sandbox 的创建、复用、休眠、销毁和租约模型。

### Docker / Podman 自建

**优点**

- 最容易在本地或一台云服务器上落地。
- 镜像、网络、CPU、内存、进程数和文件挂载都可以自行控制。
- 适合先验证 Broker、队列、取消和产物协议。

**缺点**

- 普通容器不是强安全边界，内核漏洞、错误挂载、Docker Socket 和过高权限都会造成宿主机风险。
- 需要自己处理并发、僵尸容器、镜像清理、日志、资源回收和异常重启。
- 不应让 Next.js 进程直接持有 Docker/Podman Socket；应通过独立 Broker 调度。

**适用边界**：本地开发和可信任务可以使用。执行不可信的模型生成命令时，至少需要非 root 用户、只读根文件系统、丢弃能力、禁网或受限网络、无特权、资源限制和独立工作目录；生产环境还应增加 gVisor、Kata 或 microVM。

### Firecracker / Kata Containers / gVisor 自建

**优点**

- 可以建立比普通容器更强的隔离边界。
- 策略、镜像、网络和密钥注入完全由自己控制。
- 适合把 Sandbox Broker 做成长期基础设施。

**缺点**

- 需要自己实现或维护镜像分发、调度、预热、快照、回收、审计和故障处理。
- Firecracker 通常需要确认节点是否提供可用 KVM；云主机不一定默认暴露。
- 开发、测试和安全验证成本明显高于托管方案。

**当前项目迁移成本**：高。建议先稳定 Broker 的抽象和运行协议，再替换底层 Executor，不要让 Web 层直接管理 microVM。

### 国内云厂商代码解释器

阿里云百炼、百度智能云千帆等平台提供过代码解释器或 Agent 代码执行能力，适合 Python 数据分析、文件解析和图表生成。

**优点**

- 国内账号、网络和付款链路通常更方便。
- 不需要自行维护容器和节点。
- 对“运行 Python 并返回结果”的场景接入较快。

**缺点**

- 通常是受限的 Python 工具，不等价于通用 Linux Sandbox。
- 可能不支持任意 Shell、长期进程、浏览器、依赖安装、持久工作区或自定义网络出口。
- 具体能力、地域和价格受产品版本与账号权限影响，需要以控制台实际开通结果为准。

**当前项目迁移成本**：高于表面看起来的 SDK 改造成本。当前 Skill 运行依赖固定 Bundle、入口、文件写入、结果校验和取消；若代码解释器只接受一段 Python，需要重新设计执行协议。

## 关键能力比较

| 能力 | E2B | OpenSandbox | Modal | Daytona | Docker/Podman | 云厂商代码解释器 |
| --- | --- | --- | --- | --- | --- | --- |
| 任意 Shell 命令 | 支持 | 支持，取决于运行时 | 需核实 | 通常支持 | 支持 | 通常受限 |
| 固定依赖镜像 | 支持模板 | 支持镜像/模板 | 支持容器 | 支持工作区镜像 | 完全可控 | 通常受限 |
| 强隔离 | 平台提供 | 可选 gVisor/Kata/Firecracker | 平台提供 | 取决于部署 | 默认不足 | 平台提供但不可控 |
| 禁止网络 | 支持 | 可配置 | 需核实 | 可配置程度取决于部署 | 可配置 | 通常不可细调 |
| 文件读写 | 支持 | 支持 | 支持 | 支持 | 支持 | 通常支持 |
| 长生命周期工作区 | 较弱 | 可设计 | 需核实 | 强 | 强 | 较弱 |
| 自托管 | 否 | 是 | 否 | 是 | 是 | 否 |
| 国内部署便利度 | 取决于网络和账户 | 高 | 需核实 | 中 | 高 | 高 |
| 运维负担 | 低 | 中高 | 低 | 中高 | 中 | 低 |

## 成本比较

### 托管服务

E2B、Modal 和云厂商代码解释器通常按 Sandbox/容器运行时间、CPU、内存、磁盘、网络流量或调用次数计费。优点是没有空闲节点成本，缺点是长期运行和高并发时账单不可完全由固定月费控制。具体价格应以当前官方控制台为准。

### 腾讯云自建 OpenSandbox

OpenSandbox 本身没有软件授权费。个人测试环境可以先用一台 CVM 和 Docker，通常需要承担：

- CVM 计算资源
- 云硬盘
- 公网 IP 或 NAT/CLB
- 镜像仓库、COS 和日志
- Sandbox 实际运行产生的 CPU、内存和公网流量

经验预算：单台测试机约 **¥200～600/月**；小型多节点生产环境约 **¥800～2,000/月起**。这是基础设施区间，不包含高并发、浏览器任务、跨地域流量和人工运维。

## 针对当前项目的建议

当前项目的 Skill Runtime 位于 `lib/sandbox/client.ts`，流程是：

1. 从数据库读取不可变 Skill 版本。
2. 获取 Bundle、模板和输入约束。
3. 创建 E2B Sandbox。
4. 上传 Bundle 和 `input.json`。
5. 执行固定入口。
6. 读取并校验 `result.json`。
7. 记录 Run 状态并销毁 Sandbox。

推荐分三步迁移：

1. **短期**：继续保留 E2B，修正验证和额度问题；同时把客户端包在一个 `SandboxRuntime` 接口后面。
2. **开发验证**：用本地 rootless Podman 或一台腾讯云 CVM 部署 OpenSandbox，验证 Bundle、文件、结果、超时、取消和清理语义。
3. **生产选择**：若要执行不可信代码，使用 OpenSandbox 的 Kubernetes 运行时，并启用 gVisor、Kata 或 Firecracker；若只是个人可信 Skill，容器运行时即可降低成本。

建议先定义供应商无关的接口：

```ts
interface SandboxRuntime {
  create(input: { image: string; timeoutSeconds: number; network: "none" | "restricted" }): Promise<{ id: string }>;
  writeFile(id: string, path: string, contents: Uint8Array): Promise<void>;
  run(id: string, command: string[], timeoutSeconds: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(id: string, path: string): Promise<Uint8Array>;
  kill(id: string): Promise<void>;
}
```

这样可以把 E2B、OpenSandbox 和本地 Executor 作为不同实现，保留现有的权限、Bundle SHA-256、输入/输出 Schema、超时、取消、审计和 Run 状态逻辑。

## 需要在选型前验证的事项

- Sandbox 是否真正隔离宿主机，而不只是启动了一个普通容器。
- 是否可以关闭网络，或只允许固定域名和端口。
- 是否支持强制非 root、只读根文件系统、丢弃 Linux capabilities 和 PID 限制。
- 取消请求能否杀掉实际进程，而不只是把数据库状态改成 `cancelled`。
- 节点或 Web 进程重启后，未完成 Run 如何恢复和清理。
- 镜像和依赖是否能固定到 digest，避免执行环境漂移。
- 日志、产物和密钥是否会泄露到 Sandbox 或公网。
- 并发上升时是否有配额、背压、超时和成本上限。

架构依据：当前 [E2B Skill Runtime](./e2b-skill-runtime.md)、[项目 README](../../README.md) 以及 OpenSandbox 官方仓库。本文中的供应商价格和产品能力会变化，部署前应再次查看官方文档和控制台。
