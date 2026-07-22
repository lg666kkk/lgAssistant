# 可观测性：Trace 与 Eval

> 后续完善项见 [Agent 可观测性现状评估与完善方案](./agent-observability-improvement-plan.md)。

## 这个功能解决什么问题

Agent Loop 之前只有零散 `console.log`，**无法回答"这次为什么慢 / 为什么调错工具 / 比上周变差了吗"**。可观测性给出两条腿：

- **Trace（线上）**：把一次 `runAgentLoop` 记成结构化调用树（每轮模型/工具的输入输出摘要、token、耗时、成败），打印到终端并落库 Supabase，可查询历史。
- **Eval（离线）**：用例集 → 期望工具/结果 → 自动断言，改了 loop 能回归验证没退化。

按「先有尺子，再改东西」的逻辑，能力3 排在记忆（能力2）之前。

## 核心概念

- **一次 Agent 请求是一棵调用树**：模型调一次 → 可能要求并行调多个工具 → 工具结果回传 → 再调模型……直到出最终文本。Trace 就是把这棵树结构化记录下来。
- **判别联合（discriminated union）**：model step 和 tool step 字段不同，但要放进同一个 `steps[]`。用公共字段 `type: "model" | "tool"` 区分，遍历时 `if (step.type === "tool")` 一判断，TS 自动收窄类型，安全访问各自专属字段。和 Anthropic content block（`type:"text"|"tool_use"`）是同一套路。
- **Trace（明细）vs Metrics（聚合）**：metrics 是一眼看的汇总数字（总 token、调用次数），trace 是逐步排查的明细。职责不同，**并存**。
- **Eval 断言客观事实，不断言"答案对不对"**：调没调对工具、几次模型调用、有没有报错——这些能确定地自动断言。"答案文字对不对"需要 LLM-as-judge，复杂又不稳定，留作进阶。
- **依赖注入做可测性**：给 loop 开一个 `deps.callModel` 注入口，测试时换成假函数，就能在不调真模型的前提下测编排逻辑。

## 工程实现

### 整体流程

```
Trace 腿：runAgentLoop 每轮 push TraceStep → 4 个出口 finalizeTrace 回填总览
        → route 打印调用树 + saveTrace 落库 agent_traces
Eval 腿：cases.ts 定义期望 → run-eval.test.ts 跑 loop → 断言 trace/metrics
        → mock 轨默认跑（注入假 callModel），live 轨 EVAL_LIVE=1 真调模型
```

### 关键代码走读

**[trace.ts](../../../lib/agent/runtime/trace.ts) — 判别联合**
`TraceStep = ModelTraceStep | ToolTraceStep`，公共基 `TraceStepBase` 带 model/tool 共享的递增 `index`（还原真实时间线）。`summarizeText` 复用 `truncateToolContent(text, 500)`，避免散落魔法数字。

**[index.ts](../../../lib/agent/runtime/index.ts) `runAgentLoop` — finalizeTrace 去重**
4 个 return 出口（completed / token_budget_exceeded / repeated_tool_call / max_iterations）都要回填 `stopReason/completed/endedAt/totalDurationMs/metrics`。提取本地 `finalizeTrace(stopReason, completed)` 就地改并 return trace，每个出口写一行 `trace: finalizeTrace(...)`，避免重复 20 行。

**[trace-store.ts](../../../lib/agent/runtime/trace-store.ts) — 落库**
```ts
if (!hasSupabaseConfig()) return;            // 没配置静默跳过
const { error } = await getSupabase().from("agent_traces").insert({...});
if (error) console.error("[saveTrace] 落库失败:", error.message);  // 失败只记录不抛
```

**[run-eval.test.ts](../../../lib/agent/eval/run-eval.test.ts) — 双轨**
```ts
describe("eval (mock)", () => { /* 注入 fakeCallModel，验证编排，默认跑 */ });
describe.skipIf(!RUN_LIVE)("eval (live)", () => { /* EVAL_LIVE=1 才真调模型 */ });
```

### 技术选型与决策

- **saveTrace 用 service-role client（`getSupabase()`），不用 SessionManager 的 anon client**：trace 落库是纯后端行为，必须走 service-role，否则撞 RLS / 权限。
- **观测性失败不拖垮主链路**：saveTrace 写失败只 `console.error` 不抛，聊天请求照常返回。
- **eval 双轨而非二选一**：mock 测不到"模型会不会选对工具"（eval 最有价值的部分），但真调模型花钱/慢/非确定/需 key、不适合 CI。故默认 mock（确定快免费、进 CI）+ `EVAL_LIVE=1` 手动 live。
- **依赖注入而非 `vi.mock`**：直接传假函数更干净，不 hack 模块系统；默认值 `{ callModel }` 保证生产调用方零改动。
- **steps 整存单张 JSONB 表**：现阶段只写不查明细，JSONB 最省事。

## 踩坑记录

- **vitest 不认 `@/` 别名**：tsconfig 的 `paths` vitest 不自动读，必须加 `vite-tsconfig-paths` 插件，否则 `import "@/lib/..."` 报 Cannot find module。
- **config 模块加载即校验 env**：`lib/platform/config.ts` 在 `typeof window === 'undefined'` 时立即 `validateEnv()`——**只要 import 链碰到它就校验**。所以 `vitest.config.ts` 顶部要先 `dotenv.config({ path: ".env.local" })` 注入环境变量，否则一 import 就抛"缺少环境变量"。
- **纯类型文件用 `import type`**：trace.ts 从 index.ts 导类型用 `import type`，避免把 Anthropic client 的副作用拉进来——否则 vitest 测纯函数也会因缺 key 而炸。
- **live 轨 401 反向印证双轨价值**：实测 live 轨因 `.env.local` 的 key 失效全部 401，而 mock 轨照常绿。这正说明把 key/网络这类环境问题隔离在 live 轨之外、CI 只跑 mock 轨是对的——key 过期不会让 CI 误报。
- **anon client vs service-role client**：用错 client 落库会撞 RLS。后端落库一律走 service-role。

## 延伸阅读

- 上一步：[context-token-budget.md](../context/context-token-budget.md)（能力1，本笔记的 trace 复用了它的 `truncateToolContent`）。
- 进阶方向：LLM-as-judge 给开放式回答打分；trace 前端可视化（依赖能力4 结构化事件协议，届时一起做）；eval 输出通过率/平均耗时/token 汇总表。
- Anthropic: Building effective agents / 可观测性实践。
