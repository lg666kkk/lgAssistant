# 模块边界

项目当前采用同仓库、单 Next.js 部署进程下的分层结构。目录边界先于服务拆分；只有
安全、资源或扩缩容边界明显不同的能力（例如 Go Sandbox Broker）才独立部署。

## 依赖方向

```text
app routes/pages
  |---> apps/web --------------------> packages/contracts
  |---> packages/application --------> packages/contracts
  |          ^
  |          |
  `---> packages/infrastructure -----> legacy lib implementations
```

- `packages/contracts`：可序列化 DTO、事件协议和纯函数；零框架、零 I/O。
- `packages/application`：用例编排和 Ports；不能依赖 Web 或 Infrastructure。
- `packages/infrastructure`：Supabase、Redis、Langfuse 等 Ports 实现。
- `apps/web`：浏览器组件、hooks、状态和浏览器认证；通过 API 使用后端能力。
- `app`：Next.js 路由适配器和页面入口，不承载可复用业务实现。
- `lib`：尚未迁移的 Agent Runtime 与领域实现；后续逐步归入明确 package。

## 自动检查

```bash
npm run check:architecture
npm run check
npm run lint
```

`check:architecture` 会检查别名和相对路径，阻止反向依赖、旧前端目录回流、contracts
访问环境变量，以及聊天 Route 再次膨胀。ESLint 提供编辑期反馈，架构脚本作为 CI 硬门禁。

新增跨层依赖时，应先在 Application 定义 Port，再由 Infrastructure 实现；不能通过深层
相对路径绕过边界。
