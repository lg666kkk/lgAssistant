# E2B Skill Runtime

Skill 的管理、不可变版本和 Run 记录仍存于 PostgreSQL。Next.js 服务端从发布版本读取 Bundle 与模板 ID，在 E2B 创建临时 Sandbox，上传经过校验的 Bundle 与 `input.json`，执行固定入口，校验 `result.json`，最后销毁 Sandbox。浏览器和模型都不能提交任意命令或 E2B 模板。

## 启用

1. 先应用 `docs/schemas/migrations/20260904-sandbox-runtime.sql`、`20260905-skill-list-detail.sql`（如尚未应用），再应用 `20260928-e2b-skill-runtime.sql`、`20260928-user-sandbox-config.sql` 和 `20260929-sandbox-execution-log.sql`。
2. 登录后在“连接 > 沙盒环境”保存当前用户的 E2B API Key。密钥使用服务端 `CONFIG_ENCRYPTION_KEY` 加密；未保存个人密钥时可回退到服务端 `E2B_API_KEY`。默认使用 E2B `base` 模板；固定依赖或可复现环境时配置 `E2B_SKILL_TEMPLATE_ID`。使用 `coding-untrusted` Profile 时可另配 `E2B_CODING_TEMPLATE_ID`。
3. 发布新 Skill 版本。原 OCI 镜像版本保留作历史记录，但无法在 E2B 执行。若旧 Broker 留下未完成的 Run，应先核对并单独处理，避免影响新 E2B Run。
4. 上传 `.tar` Bundle，入口从 `/home/user/workspace` 执行，读取 `input.json` 并写出 `result.json`。示例位于 `docs/markdown-check-example`。

E2B Sandbox 创建时设置 `allowInternetAccess: false`；不向 Sandbox 传入数据库、模型或应用密钥。发布版本绑定服务端允许的模板 ID，运行时验证 Bundle SHA-256 和输入/输出 JSON Schema。命令、结果与日志均受大小和时长限制。`sandbox_runs.execution_log` 保存创建、上传、执行、读取结果、销毁和失败阶段，并通过 `run_skill` 的 Tool Trace metadata 展示。

## 聊天终端

`run_terminal_command` 是独立于 `run_skill` 的通用终端工具。每条命令都需要用户在聊天中确认，然后在该用户、该聊天专用的 E2B Sandbox 中执行。终端 Sandbox 允许联网，支持 `npx skills find` 等 CLI；不挂载应用服务器文件，也不传入应用密钥。默认工作目录为 `/home/user/workspace`。同一聊天的文件与软件安装会跨命令保留，空闲约 30 分钟后 Sandbox 过期并重建；删除聊天时会尝试立即销毁。在终端运行 `npx skills add` 只会修改此沙盒，不会导入应用的 Skill 列表。默认 `base` 模板的 Node 版本不足以运行新版 Skills CLI，因此首次创建时会安装 Node 22.21.0 和 npm 10.9.4；可用 `E2B_CODING_TEMPLATE_ID` 指向预装所需运行时的模板。

## 运行边界

`POST /api/skills/runs` 持久化 Run 后，在当前 Next.js Node 进程中启动异步执行并立即返回 `queued`。页面和 Agent 查询同一个 Run；取消接口将 Run 标为 `cancelled` 并调用 E2B 的 Sandbox kill API。进程意外退出后，查询接口会将超过超时窗口的非终态 Run 标为失败并尝试清理 E2B Sandbox。

这个版本适合短时 Skill 任务，**不提供进程重启后自动重试**。需要可恢复的长时任务时，应把 `executeSkillRun` 放入持久任务编排服务；E2B 只负责隔离执行，不替代任务队列。
