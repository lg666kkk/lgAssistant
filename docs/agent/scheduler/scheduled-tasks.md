# 定时任务与主动消息

定时任务负责在指定时间运行提醒、LeetCode 练习或 Agent 内容任务。每次结果默认保存在项目内供任务详情预览，也可以可靠地推送到 Telegram Bot 或企业微信群机器人。

## 页面设置

“什么时候执行”支持“仅执行一次”和“重复执行”。重复任务默认每天北京时间 09:00，可直接选择：

- 每天：选择执行时间。
- 每周一至周五：不包含周末，但不会自动按法定节假日或调休调整。
- 每周：勾选一个或多个星期，再选择执行时间。
- 每月：选择 1–31 日；没有该日期的月份会跳过，而不是提前到月末执行。
- 自定义 Cron（高级）：保留复杂表达式，使用原有服务端校验。

表单实时展示中文执行规则，时区可选择“北京时间”等常用选项，也可手动填写 IANA 标识。重复执行的时间按所选时区解释；一次性任务按当前设备本地时间输入，提交绝对时间戳。高级 JSON 参数通常保持默认即可。

普通频率在前端转换成原有 `cron` 字段，不改变 API 或数据库结构。编辑已有任务时，可识别的规则回填普通表单，复杂规则保留原文并进入高级模式，不会自动改写为默认规则；主动选择普通频率才会替换复杂规则。

## 当前架构

```text
对话工具 / 管理页面
        |
        v
Supabase scheduled_jobs（任务真相源）
        |
        | claim_due_scheduled_jobs：事务锁 + SKIP LOCKED + lease
        v
/api/cron/tick（每分钟）
        |
        +--> handler：reminder / leetcode-daily / agent-task
        |        |
        |        v
        |    scheduled_job_runs（执行结果）
        |        |
        |        v
        |    scheduled_deliveries（Outbox）
        |             |
        |             +--> Telegram Bot API
        |             +--> 企业微信群机器人
        |
        +--> claim_due_scheduled_deliveries（失败重试）
```

Redis 不再保存 scheduler 的权威时间轴。应用和 Redis 重启后，下一次 tick 会直接从 Supabase 领取到期任务。

## 数据库

首次启用前依次执行：

1. `docs/schemas/scheduled-jobs-schema.sql`（尚未创建基础任务表时）
2. `docs/schemas/migrations/20260904-reliable-scheduler-channels.sql`

迁移增加：

- `scheduled_jobs.lease_owner / lease_until`
- `user_notification_channels`：用户级加密通道凭证
- `scheduled_deliveries`：独立、可重试的消息 Outbox
- `claim_due_scheduled_jobs()`：原子领取任务
- `claim_due_scheduled_deliveries()`：原子领取消息投递

服务端使用 `SUPABASE_SERVICE_ROLE_KEY` 调用 claim RPC。浏览器不能直接访问凭证表或投递表。

## 任务生命周期

1. tick 原子领取 `next_run_at <= now` 且租约空闲的任务。
   周期任务超过 10 分钟执行宽限期时不补跑旧内容，而是记录 `skipped` 并重新排期；一次性任务仍会执行。
2. 创建 `running` 状态的 `scheduled_job_runs`。
3. handler 运行内容任务并保存结果。
4. 周期任务计算下一次时间；一次性任务成功后停用。
5. 运行结果写入 `scheduled_job_runs`，任务详情按时间展示 Markdown 预览。
6. 根据 `payload.channels` 为每个外部通道创建一条 delivery。
7. delivery worker 发送消息；失败采用指数退避，最多尝试 5 次。

内容执行和消息投递是两个状态。消息平台故障只重试 delivery，不会重新运行一次 Agent。

任务 payload 示例：

```json
{
  "prompt": "总结今天的重要 AI 新闻并列出来源",
  "channels": ["inapp", "telegram", "wecom"]
}
```

## 消息通道

### Telegram

用户在定时任务页面保存：

- Bot Token：使用 `CONFIG_ENCRYPTION_KEY` 加密后入库
- Chat ID：作为非密钥设置保存

点击“测试”后，服务端调用 Telegram Bot API 发送测试消息。长消息自动分段，Bot Token 不返回浏览器。

### 企业微信

第一版支持企业微信群机器人，只接受以下官方地址：

```text
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

完整 URL 包含密钥，因此整体加密保存。任意域名 Webhook 不再作为任务参数执行，以避免 SSRF 和凭证泄漏。

个人微信机器人不在支持范围内。需要双向微信会话时，应扩展企业微信自建应用回调，并校验签名与加密消息。

## 生产心跳

VPS 使用 `deploy/systemd/personal-assistant-scheduler.service` 和 `.timer`。`scheduler-tick.sh` 只从服务器受保护的 `.env.production` 读取 `CRON_SECRET`，并通过 curl 标准输入传递请求头，避免密钥写入 unit 或进程命令行。timer 每分钟请求本机地址：

```text
http://127.0.0.1:3000/api/cron/tick
```

tick 接受匹配的 `Authorization: Bearer` 或 `x-cron-secret`。开发环境可运行 `npm run scheduler:dev`，非 2xx 响应会输出明确错误。

## 关键状态

任务：

- `enabled=true`：等待或周期运行
- `lease_until`：当前 worker 的执行租约
- `last_result / last_error`：最近一次内容执行结果

投递：

- `pending`：等待发送
- `sending`：已被 worker 领取
- `delivered`：平台已接受
- `retry_wait`：等待重试
- `dead`：达到最大尝试次数

## 运维检查

```bash
systemctl status personal-assistant-scheduler.timer
journalctl -u personal-assistant-scheduler.service -n 50 --no-pager
docker compose logs --since 1h app | grep -Ei 'scheduler|cron'
```

管理页面分别展示站内运行结果和外部消息投递状态，不能把“Agent 已完成”误报成“Telegram/企业微信已送达”。

任务列表支持启停、立即运行和查看运行记录。立即运行与定时 tick 共用数据库租约，避免并发重复执行，并且不会改变周期任务原有的下一次计划。运行记录按任务加载，每次运行都可以在站内打开完整 Markdown 结果。

`agent-task` 会保存当前用户模型记录 ID。创建或修改时必须选择用户已启用的模型；执行时再次解析该模型，模型被停用或删除后任务会明确失败，不会静默切换到其他模型。
