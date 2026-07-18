# 记忆双写原子性（长期层 + 语义层同事务）

## 这个功能解决什么问题

一条记忆要同时写两张表：长期层 `agent_memories`（按 key 精确取）和语义层 `agent_semantic_memories`（按向量召回）。
原实现是 `Promise.all([longTerm.set(...), semantic.set(...)])`——两次独立网络写，**非原子**：
一个成功一个失败时，两层永久漂移（长期有、语义无，或反之），而代码只在 `catch` 里打一行日志，
不会自愈。失效（invalidate）也是同样的双写，风险相同。

目标：让「写一条记忆」「失效一条记忆」变成**要么两层都成、要么两层都不动**。

## 核心概念

- **同库 = 可用单事务**：两张表都在同一个 Supabase Postgres 实例里。只要把两次写放进
  **同一个数据库事务**，就天然原子——不需要 outbox、不需要后台补偿 worker。
- **plpgsql 函数即事务边界**：Postgres 里一个函数默认在**单个事务**中执行。函数体内两条
  `INSERT ... ON CONFLICT` 任一报错，整段回滚。通过 `supabase.rpc()` 调用它，应用层拿到的是
  「一次调用、原子结果」。
- **为什么不用 outbox**：outbox（先写权威表 + 事件表，后台 worker 补投另一层）能解决跨库/跨服务的
  最终一致，但要引入事件表、worker、重试与去重，重得多。本场景两表同库，单事务是更小的正确解。

## 工程实现

### 整体流程

```
consolidate / handleExplicitForgetRequest
  └─ writer.upsert(key, content, metadata, {userId})
        1. embedSingle(content)  → 1024 维向量（失败在此抛出，DB 尚未写，无半写）
        2. buildUpsertParams(...) → 拍平成命名参数（纯函数，可单测）
        3. supabase.rpc('upsert_memory', params)
              └─ 事务内: INSERT agent_memories  + INSERT agent_semantic_memories
                 任一失败 → 整体回滚
  └─ writer.invalidate(key, {userId})
        └─ supabase.rpc('invalidate_memory', ...) → 事务内两表 active→invalidated
```

### 关键代码走读

- SQL：[migrations/20260718-atomic-memory-write.sql](../schemas/migrations/20260718-atomic-memory-write.sql)
  的 `upsert_memory` / `invalidate_memory`。两条 `ON CONFLICT (user_id, key) DO UPDATE` 放在同一个
  函数体里，靠函数的隐式事务保证原子。`ON CONFLICT` 里**不覆盖 `created_at`**，保留首次创建时间。
- `buildUpsertParams`（[atomic-writer.ts](../../lib/agent/memory/atomic-writer.ts)）刻意抽成**纯函数**：
  它复用 `memoryColumnsFromMetadata` 把 metadata 里的 `type/source/confidence/importance/status` 归一到
  合法值（clamp + 白名单），避免违反表上的 CHECK 约束。纯函数没有 DB/embedding 依赖，能直接单测。
- `MemoryWriter.upsert` 先 `embedSingle` 再 `rpc`：**embedding 失败发生在任何 DB 写之前**，所以失败
  路径也不会产生半写。
- 结线：[memory-flow.ts](../../lib/agent/memory/memory-flow.ts) 三处 `Promise.all` 双写全部替换为
  `writer.upsert` / `writer.invalidate`。`longTerm`/`semantic` store 仍保留，用于 `get`/`recall`/`touch`
  等读路径。

### 技术选型与决策

- **单事务 RPC vs outbox**：选前者，理由见「核心概念」。若未来长期层与语义层拆到不同库/服务，
  再升级为 outbox。
- **embedding 在应用层算、当参数传入**：pgvector 无法在 SQL 里调用外部 embedding API，所以向量必须
  应用层算好，作为 `VECTOR(1024)` 参数传给函数。`supabase.rpc` 传 `number[]` 即可。
- **保留 store 的单表 set/invalidate**：接口完整性需要；但记忆主流程一律走 `writer`，避免有人误用单表写
  再次引入漂移。

## 踩坑记录

- **`ON CONFLICT` 会重置 `valid_from`**：upsert 每次把 `valid_from` 设为 now（= 本版本生效时间），
  这是刻意的语义，不是 bug；但要清楚它不是「首次创建时间」，那个用 `created_at`（不被覆盖）。
- **RPC 参数名必须与函数形参逐字一致**：`supabase.rpc(fn, obj)` 按对象 key 映射命名参数，`p_user_id`
  等前缀写错就报「function does not exist」。
- **迁移里函数用 `CREATE OR REPLACE`**：可重复执行；但改了**返回类型/参数签名**时要先 `DROP FUNCTION`
  （见 `match_memories` 的处理），否则 `CREATE OR REPLACE` 会因签名不同而报错。

## 延伸阅读

- [分层记忆系统](./layered-memory.md) — 记忆整体架构（本改动属于其中的写入可靠性一环）
- 迁移：[20260718-atomic-memory-write.sql](../schemas/migrations/20260718-atomic-memory-write.sql)
- 单测：[atomic-writer.test.ts](../../lib/agent/memory/atomic-writer.test.ts)
