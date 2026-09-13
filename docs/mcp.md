# MCP 外部工具接入

本项目作为 MCP Client，通过 Streamable HTTP 连接服务，将获准使用的远端工具适配为 `ToolDefinition`。工具由现有 Agent Runtime / Tool Router 执行，继续使用工具确认、限流、超时和 Trace。模型 provider 只收到工具 schema，不负责执行 MCP 工具。

## 配置

在侧边栏打开 **连接 → MCP**，点击“添加服务”，填写名称、公网 HTTPS 地址和可选的 Bearer Token，再点击“测试连接并发现工具”。选择允许使用的工具，勾选“在对话中启用此服务”并保存。默认每次调用需要确认，只有已核实的只读工具才应选择“只读免确认”。

页面支持编辑、删除、清除 Token 和查看工具。个人服务存入 `user_mcp_servers`，每个查询都绑定登录用户，Token 使用现有 `CONFIG_ENCRYPTION_KEY` 加密，列表不返回明文或密文。空 Token 保留原值；更换端点必须重新填写或清除原 Token，防止旧凭据发给新服务。配置保存后下一轮对话生效。

新环境先执行 `docs/schemas/migrations/20260913-user-mcp-servers.sql`。未初始化时页面显示明确提示并禁用保存。数据库启用 RLS，浏览器角色没有直接表权限。

当前不包含 OAuth、stdio、Resources 或 Prompts。没有启用的个人服务时，不加载外部工具。

每个用户最多添加 8 个服务，每个服务最多允许 32 个工具。MCP 统一通过页面配置。

## 执行路径

1. 聊天请求认证、模型解析后，加载该用户的允许列表。
2. 每个服务建立独立请求级连接；初始化和工具发现总计最多 10 秒，支持分页。
3. 本地适配器编译参数 JSON Schema，保留完整 schema；使用 AJV Draft-07 校验，支持常用 formats，不支持的 schema 会使该服务本轮不可用。
4. 工具生成稳定的 `mcp_..._<hash>` 名称，在 `run-chat.ts` 中注册，再参与现有路由过滤。
5. 模型请求调用后，Router 检查风险并执行；适配器再次检查当前用户及参数，调用远端原始工具名。
6. 正常结束、请求取消、响应流取消、异常或提前返回都关闭连接；正常关闭对有状态服务尝试发送 DELETE，清理最多等待 1 秒。

上下文预览也会发现相同工具，以计入工具描述和 schema 的 token 预估，发现结束即关闭，不调用工具。因此启用 MCP 后，上下文预览也会产生连接开销。

## 结果与故障行为

- `isError: true` 被转换为工具失败；HTTP 成功不代表工具执行成功。
- 文本和 `structuredContent` 进入模型结果；结果文本上限约 16,000 字符，超长结构化副本被省略。此限制控制进入模型/Trace 的大小，不是网络响应字节上限。
- 图片、音频、resource/link 等块目前只显示“不支持展示”提示，不解码、下载或自动读取。
- 服务 ID、远端工具名、截断标记进入 metadata，Router 补充耗时。传输异常不直接输出 URL、认证头或原始错误。
- 服务配置无效或服务不可用时，日志记录脱敏提示，跳过受影响的外部工具，内置工具继续可用。某个配置工具缺失或 schema 无法编译时，整个服务本轮跳过。
- 工具调用不自动重试。写操作中断后状态可能未知，应先核实远端状态。
- MCP 只提供协议调用，不提供进程沙箱。`sandboxed` 为 false；远端 annotations 不决定本地安全策略。
- 通用读取工具的 grounding 为 `none`，写工具为 `action_receipt`。远端结果仍可供模型阅读，但不会自动生成本项目的 `EvidenceBundle`；要接入引用校验型 RAG，需要专门的输出适配器。

## 验证

```sh
npx vitest run lib/agent/tools/mcp-adapter.test.ts packages/application/src/mcp packages/infrastructure/src/mcp packages/application/src/chat/run-chat.test.ts packages/application/src/chat/preview-context.test.ts
npm run check
```

HTTP 集成测试启动本地真实 MCP SDK 服务，验证握手、分页发现、工具允许列表、Bearer 认证、Router 调用和会话 DELETE。它不需要远端 API Key，也不调用模型供应商。实际服务 URL 和账号仍需配置后验证。
