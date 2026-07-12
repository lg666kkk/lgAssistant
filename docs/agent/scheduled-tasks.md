# 定时任务能力（Scheduler）

> 本文是**设计文档 + 学习笔记**，用于在当前项目中引入统一的定时任务能力。
> 需求背景：同时支持三类任务 —— ①固定任务定时跑、②用户自定义提醒、③Agent 主动执行 prompt。
> 部署环境尚未确定，因此设计的第一原则是 **触发器与任务逻辑解耦**，让"接哪个平台"变成最后一步的几行配置。

---

## 这个功能解决什么问题

当前项目所有"到点该做的事"都靠**前端主动请求**触发（典型是 [app/api/leetcode/daily/route.ts](../../app/api/leetcode/daily/route.ts)：用户打开页面才 GET 一次每日练习）。这意味着：

- 用户不打开页面，什么都不会发生（无法"每天早上自动推送"）；
- 无法让用户自定义"每天 9 点提醒我喝水"这类动态任务；
- 无法让 Agent 在无人值守时主动跑（如每晚自动同步 Notion、生成日报）。

定时任务能力要补的，就是一个**无人值守、按时间驱动、可动态增删**的执行层。

---

## 核心概念

实现前必须先理解这几点，否则会选错架构。

### 1. Serverless 没有"常驻进程"

Next.js API route（尤其部署到 Vercel）是**请求驱动**的：没有请求就没有进程在跑，`setInterval` 会随函数结束被销毁。所以**定时任务的"心跳"必须来自外部**——要么平台的 Cron（Vercel Cron / 云函数定时触发器），要么系统 crontab，要么一个独立常驻进程。

> 结论：**调度逻辑不能依赖"进程一直活着"**，必须设计成"每次被叫醒时，问一句：现在有哪些任务到期了？"。

### 2. Tick 模型（拉取式调度）

不给每个任务单独设一个定时器（serverless 做不到），而是：

- 有一个**统一的时间轴存储**，记录"每个任务下次该在什么时间戳执行"；
- 一个**外部心跳**每分钟叫醒一次 `tick()`；
- `tick()` 只做一件事：**把 `score <= now` 的任务全部弹出来执行**。

这就是 cron、BullMQ、Sidekiq 等所有调度器的底层套路。时间轴用 **Redis ZSET** 是最自然的选择（你已有 ioredis）：

```
ZSET  key = "scheduler:due"
      score  = 下次执行的 Unix 时间戳（毫秒）
      member = jobId
ZRANGEBYSCORE scheduler:due 0 <now>   → 取出所有到期任务
```

### 3. 一次性任务 vs 周期任务

- **一次性（runAt）**：执行完就删除（如"5 分钟后提醒我"）。
- **周期（cron）**：执行完要**算出下一次时间戳，重新入队**。需要一个 cron 表达式解析库（`cron-parser`）来算 "下一次 `0 9 * * *` 是什么时候"。

### 4. Redis 会丢数据 → 需要持久化 job 详情

Redis 默认不是强持久化。ZSET 只存"时间轴 + jobId"是可接受的（丢了顶多漏跑一次），但**任务定义**（谁的、什么类型、payload、cron 表达式）应落到 **Supabase**，Redis 宕机重启后能从 Supabase 重建时间轴。

---

## 工程实现

### 整体流程

```
┌─────────────────────────────────────────────────────────────┐
│  持久层                                                        │
│   Supabase 表 scheduled_jobs   ← 任务定义（真相源）            │
│   Redis ZSET scheduler:due     ← 时间轴（下次执行时间戳）      │
└─────────────────────────────────────────────────────────────┘
        ↑ 增删改（用户/系统）              ↓ 到点弹出
   ┌──────────────────┐          ┌────────────────────────────┐
   │ 用户 API          │          │  Tick 触发器（每分钟）        │
   │ /api/schedule    │          │  /api/cron/tick             │
   │ 增删自定义提醒     │          │  1. popDue() 弹出到期任务     │
   └──────────────────┘          │  2. 按 type 分发给 handler   │
                                 │  3. cron 类算下次时间重入队   │
                                 │  4. 失败记录 + 重试            │
                                 └────────────┬────────────────┘
                                              ↓ dispatch by type
              ┌───────────────────┬───────────────────┬───────────────────┐
        leetcode-daily         reminder            agent-task
        (生成每日练习并推送)    (给用户发通知)      (跑一段 prompt / 同步)
```

**关键：中间那个 Tick 触发器的"心跳来源"是唯一和部署平台绑定的部分。** 三类 handler、存储、API 全部与平台无关。所以现在不定部署也能先把核心写完。

### 目录结构（建议）

```
lib/scheduler/
  types.ts            # Job 定义、JobType 枚举、handler 接口
  store.ts            # Redis ZSET 增删查 + Supabase 持久化
  cron.ts             # cron 表达式 → 下次执行时间（封装 cron-parser）
  tick.ts             # 核心：popDue → dispatch → 重入队 → 重试
  handlers/
    index.ts          # type → handler 映射表
    leetcode-daily.ts # 固定任务：复用现有 getDailyLeetCodePractice
    reminder.ts       # 用户提醒：查 job.payload，推送通知
    agent-task.ts     # 让 Agent 跑一段 prompt（复用 runAgentLoop）
app/api/
  cron/tick/route.ts  # 被心跳每分钟调用；带密钥校验，防外部乱调
  schedule/route.ts   # 用户 CRUD 自定义提醒（GET/POST/DELETE）
scripts/
  scheduler-dev.ts    # 本地开发用 node-cron 每分钟调 tick，方便调试
```

### 关键代码走读（伪代码，只标关键行）

**① 时间轴存储 `store.ts` —— 一个 ZSET 管所有任务**

```ts
// 入队：把 jobId 按"下次执行时间戳"塞进 ZSET
export async function schedule(job: Job, runAt: number) {
  await redis.zadd("scheduler:due", runAt, job.id);   // 关键：score 就是时间
  await supabase.from("scheduled_jobs").upsert(job);  // 真相源落库
}

// 原子弹出到期任务：ZRANGEBYSCORE 取 + ZREM 删，用 pipeline/lua 保证不重复消费
export async function popDue(now: number): Promise<string[]> {
  const ids = await redis.zrangebyscore("scheduler:due", 0, now);
  if (ids.length) await redis.zrem("scheduler:due", ...ids); // 关键：取完立刻删，避免并发重复执行
  return ids;
}
```

> **为什么取完立刻删**：如果 tick 可能被并发触发（Vercel 偶发重复、手抖多点几次），不先删就会同一个任务跑两遍。更严谨可用 Lua 脚本把"取+删"做成原子操作。

**② 核心调度 `tick.ts` —— 弹出、分发、周期任务重入队**

```ts
export async function tick(now: number) {
  const ids = await popDue(now);
  for (const id of ids) {
    const job = await loadJob(id);           // 从 Supabase 读定义
    try {
      await handlers[job.type](job);         // 关键：按 type 分发，handler 互相隔离
    } catch (e) {
      await recordFailure(job, e);           // 失败落库，供重试/告警
    }
    if (job.cron) {
      const next = nextRunTime(job.cron);    // 关键：周期任务算下次时间
      await schedule(job, next);             // 重新入队，形成循环
    }
  }
}
```

> **周期任务的循环靠"执行后重新入队"实现**，不是靠一个长定时器。这样即使中间宕机重启，只要 Supabase 里的定义还在，重建时间轴即可继续。

**③ 触发入口 `app/api/cron/tick/route.ts` —— 唯一和平台绑定的地方**

```ts
export async function GET(req: Request) {
  // 关键：校验密钥，否则任何人都能触发你的所有任务
  const secret = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) return new Response("forbidden", { status: 403 });
  await tick(Date.now());
  return Response.json({ ok: true });
}
```

心跳来源三选一（只改这一处的"谁来调它"）：

| 部署 | 心跳配置 |
|------|---------|
| Vercel | `vercel.json` 里 `crons: [{ path: "/api/cron/tick", schedule: "* * * * *" }]` |
| VPS / 云服务器 | 系统 crontab：`* * * * * curl -H "x-cron-secret: xxx" http://localhost:3000/api/cron/tick` |
| 本地开发 | `scripts/scheduler-dev.ts` 用 `node-cron` 每分钟 `fetch` 一次 |

**④ 三个 handler —— 尽量复用现有能力**

```ts
// leetcode-daily：直接复用现成函数，不重写
import { getDailyLeetCodePractice, formatDailyLeetCodePractice } from "@/lib/leetcode/daily-practice";
export const leetcodeDaily: Handler = async (job) => {
  const practice = await getDailyLeetCodePractice({ userId: job.userId });
  await notify(job.userId, formatDailyLeetCodePractice(practice)); // notify = 通知通道
};

// agent-task：把定时任务变成"让 Agent 自己跑一段 prompt"
import { runAgentLoop } from "@/lib/agent/runtime";
export const agentTask: Handler = async (job) => {
  const result = await runAgentLoop({ userId: job.userId, input: job.payload.prompt });
  await notify(job.userId, result.finalText);
};
```

> `agent-task` 是最有想象力的一类：它把你已有的 Agent Loop 变成一个"无人值守的定时工人"，能自动做日报、同步知识库、检查提醒。

### 技术选型与决策

| 决策点 | 选择 | 为什么不选另一个 |
|--------|------|-----------------|
| 调度存储 | **Redis ZSET 自研** | 不引 BullMQ：功能够用、依赖轻、你已熟 ioredis；BullMQ 更重且偏向"任务队列"而非"定时" |
| 心跳来源 | **外部触发 `/api/cron/tick`** | 不用 `setInterval` 常驻：serverless 下不可靠，且绑死部署方式 |
| 真相源 | **Supabase 存 job 定义** | 只靠 Redis 会因宕机丢任务定义；ZSET 只当"可重建的缓存" |
| cron 解析 | **`cron-parser` 库** | 不手写：cron 语义边界情况多（月末、闰、时区），自己写必踩坑 |
| 时区 | **job 存用户时区，算 next 时带上** | "每天 9 点"必须按用户所在时区，否则跨时区全错 |
| 平台绑定面 | **收敛到单个 route** | 让"没定部署"不阻塞开发；将来换平台只改心跳配置 |
| 通知通道 | **可插拔多通道：TG + 企业微信 + 站内** | 不写死单一通道；微信侧用企业微信而非个人号（TOS）/服务号（门槛高） |

### Supabase 表结构（草案）

```sql
create table scheduled_jobs (
  id          text primary key,
  user_id     text not null,
  type        text not null,              -- 'leetcode-daily' | 'reminder' | 'agent-task'
  cron        text,                       -- 周期任务的 cron 表达式；一次性任务为 null
  run_at      bigint,                     -- 一次性任务的时间戳；周期任务为 null
  timezone    text default 'Asia/Shanghai',
  payload     jsonb,                      -- 提醒文本 / prompt 等
  enabled     boolean default true,
  last_run_at bigint,
  last_error  text,
  created_at  timestamptz default now()
);
create index on scheduled_jobs (user_id);
```

> 复用你现有的多用户隔离约定（近期 commit `多用户隔离完善`）：所有查询按 `user_id` 过滤，API 里用 `requireUser` 拿当前用户。

---

## 通知通道（已确定：Telegram + 企业微信 双通道）

handler 执行完任务后，结果要"发出去"。这一层抽象成**可插拔多通道** `notify()`：scheduler 不关心细节，job 里存"发到哪个通道"。已确定同时支持 **Telegram** 和 **企业微信**，另保留一个 `inapp` 站内通道兜底。

### 各通道可行性对比（为什么选这两个）

| 通道 | 难度 | 是否需审核/资质 | 关键限制 |
|------|------|----------------|---------|
| **Telegram Bot** ✅ | 低 | 无 | 国内服务器访问 `api.telegram.org` 需代理；海外/Vercel 无障碍 |
| **企业微信（群机器人）** ✅ | 低 | 无（免费拿 webhook） | 消息发到群，不能精准到个人 |
| **企业微信（应用消息）** ✅ | 中 | 需企业微信后台配置 corpid/secret/agentid | 能精准发给指定成员 |
| 微信服务号模板消息 🟡 | 高 | 需认证服务号（企业主体 + ¥300/年） | 门槛高，本项目暂不做 |
| 微信个人号 ❌ | —— | —— | 违反 TOS，封号风险，禁止使用 |

> 结论：**微信侧走"企业微信"**（个人也可注册），不碰个人号和服务号。群机器人最快，应用消息更精准，二选一或都支持。

### 可插拔通道架构

```ts
// lib/scheduler/notify/index.ts
type Channel = "telegram" | "wecom" | "inapp";

const channels: Record<Channel, (target: NotifyTarget, text: string) => Promise<void>> = {
  telegram: notifyTelegram,
  wecom:    notifyWecom,
  inapp:    notifyInApp,     // 写 notifications 表，前端展示，兜底
};

export async function notify(job: Job, text: string) {
  const ch = job.payload.channel ?? "inapp";      // 关键：通道写在 job 里，不写死
  await channels[ch](resolveTarget(job.userId, ch), text);
}
```

> scheduler / handler 全程只调 `notify(job, text)`，将来加钉钉、邮件、Server酱都只是往 `channels` 加一个函数，其余零改动。

### Telegram 实现要点

```ts
// notify/telegram.ts —— 一个 fetch 就够
async function notifyTelegram(target: { chatId: string }, text: string) {
  await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: target.chatId, text, parse_mode: "Markdown" }),
  });
}
```

- 接入：`@BotFather` 建 bot → 拿 `BOT_TOKEN` → 给 bot 发消息后调 `getUpdates` 拿 `chat_id`。
- `chat_id` 是**每个用户各不相同**的，存进用户设置表或 `job.payload`。
- 进阶：给 bot 配 webhook，用户回消息 → 进你的 `runAgentLoop` → 实现**双向对话式提醒**。

### 企业微信实现要点

```ts
// notify/wecom.ts —— 群机器人版（最简单）
async function notifyWecomBot(target: { webhookKey: string }, text: string) {
  await fetch(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${target.webhookKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
  });
}
```

- **群机器人**：企业微信群 → 添加群机器人 → 拿 webhook key，POST 即可，免鉴权。
- **应用消息**（精准到人）：需先用 `corpid + corpsecret` 换 `access_token`（有效期 2h，要缓存到 Redis），再调 `message/send` 带 `touser` + `agentid`。
- `access_token` 建议缓存进 Redis（你已有 ioredis），避免频繁换取被限流。

### 用户通道配置存哪

新增用户设置（或复用现有设置表），字段示意：

```
telegram_chat_id     text      -- 用户的 TG chat_id
wecom_webhook_key    text      -- 群机器人 key（可选）
wecom_touser         text      -- 应用消息目标成员（可选）
default_channel      text      -- 该用户默认走哪个通道
```

> `access_token`（企业微信）、`corpsecret` 这类**全局密钥放环境变量**，不入库；**用户级标识**（chat_id / touser）才入库。

---

## 待确认 / 未决问题

1. **企业微信用哪种？** 群机器人（最快、发到群）还是应用消息（精准到人、需后台配置）——建议先群机器人跑通，再按需加应用消息。
2. **部署平台** —— 只影响 `tick` 心跳来源，其余无关；可最后决定。
   - 注意：若国内服务器 + 要用 Telegram，需为 `api.telegram.org` 配代理；这也是 Telegram 唯一的部署约束。
3. **并发与幂等** —— 若心跳可能重复触发，`popDue` 是否升级为 Lua 原子脚本。
4. **失败重试策略** —— 立即重试 / 指数退避 / 死信记录。

---

## 实现步骤（建议顺序）

1. 建 Supabase 表 `scheduled_jobs` + 用户通道配置字段（telegram_chat_id / wecom_*）。
2. **先做通知层**：`lib/scheduler/notify/`（Telegram + 企业微信 + inapp），单独可测——不依赖 scheduler 就能先验证"手机能收到消息"。
   - 2a. Telegram：建 bot、拿 token/chat_id，跑通 `sendMessage`。
   - 2b. 企业微信：先群机器人 webhook 跑通；如需精准到人再加应用消息（access_token 缓存进 Redis）。
3. `lib/scheduler/types.ts` + `store.ts`（ZSET 增删查 + 落库），写单测。
4. `cron.ts`（封装 `cron-parser`，含时区），写单测覆盖月末/时区。
5. `tick.ts` 核心分发逻辑。
6. 先接**一个** handler：`leetcode-daily`（复用现成函数 + 第 2 步的 notify，最快端到端看到手机收推送）。
7. `app/api/cron/tick/route.ts` + `scripts/scheduler-dev.ts` 本地跑通端到端。
8. 加 `reminder` handler + `app/api/schedule` 用户 CRUD API（含选择通道）。
9. 加 `agent-task` handler（复用 `runAgentLoop`）。
10. 最后按实际部署平台，配置真实心跳（Vercel Cron / crontab）；国内 + TG 记得配代理。

---

## 延伸阅读

- [app/api/leetcode/daily/route.ts](../../app/api/leetcode/daily/route.ts) —— 现有"伪定时任务"，最先改造的对象
- [lib/agent/runtime/index.ts](../../lib/agent/runtime/index.ts) `runAgentLoop` —— agent-task handler 的复用点
- [lib/chat/session-manager.ts](../../lib/chat/session-manager.ts) —— 多用户会话隔离参考
- `cron-parser`（npm）—— cron 表达式解析与下次时间计算
- Vercel Cron Jobs 官方文档 —— 心跳来源之一
- Telegram Bot API `sendMessage` / `getUpdates` / `setWebhook` —— TG 通道接入
- 企业微信「群机器人」webhook & 「应用消息」`message/send` / `gettoken` —— 微信侧通道接入
