# 执行策略：能力、编排与授权分离

## 三个独立维度

- 能力选择：普通工具、标准 Skill、沙盒版本都来自同一套受治理的工具注册表。
- 执行编排：普通 Agent 循环处理单一目标和短工具链；Plan-and-Execute 处理需要阶段检查点的多个子目标。
- 操作授权：登录、风险等级、工具确认仍由 Tool Router 校验。计划是否经过审核，不等于批准计划里的具体工具。

不再按字数、动作词数量、“然后”等连接词分流，也不再为包含 Skill 或“技能”的请求设置豁免。

## 请求流程

```text
已确认计划 → 校验计划及续跑控制 → executePlan（不重新分类）

普通请求 → selectExecutionStrategy
  ├─ 没有可用工具 → 普通回答，不增加分类模型请求
  ├─ direct → runAgentLoop（保留本轮可用工具）
  ├─ plan + 不要求审核 → 生成计划 → plan_started → executePlan
  ├─ plan + 用户要求先审核 → 生成计划 → plan_proposal → 等待确认
  └─ 分类超时/异常/无效 JSON → 普通回答或澄清，工具 schema 和可执行注册表均为空
```

模型返回 `executionMode`、`requiresPlanReview`、`reason` 和 `subgoals`。
运行时严格校验结构、枚举和长度；拒绝额外的 `approved` 等字段。
计划最多四个阶段。是否包含 Skill 不影响执行模式；发现、加载 Skill
通常只是某个任务的前置工具链，不应机械拆成多个交付目标。

`requiresPlanReview` 只表示用户要求“先给执行计划，等我确认后再做”，
不是工具风险评估。复杂的只读任务可以自动进入计划执行；简单的写操作
也可能被工具确认拦截。普通的“写一份计划文档”仍可直接回答。

计划生成或 JSON 修复仍失败时，停止本轮工具执行，不再套用固定的
“收集资料、比较分析、确认偏好”模板。模型判断并非绝对准确，语义质量
需要结合真实模型回放评估；结构校验不能代替语义正确性评估。

## 成本、取消与安全边界

- 使用本轮选择的模型，分类增加一次最多 600 输出 token 的模型请求。
- 输入只包含有限的最近文本上下文、当前任务和工具说明，不注入上传脚本，
  不把工具结果当成用户任务。历史上下文依然是不可信数据。
- 分类请求设置 10 秒取消信号并关闭自动重试，透传到 provider；用户取消时
  不继续生成或执行计划。分类降级不授予任何工具权限。
- 分类、规划不会设置 Tool Router 的 `approved`。规划中遇到待确认工具仍暂停。
- 分类生成开销与原规划调用一样，不属于 Agent Loop 的逐步模型使用量，
  不应把聊天底部的 loop token 汇总视为完整编排成本。

## 可观测性与前端

本地 `agent_traces.steps` 新增 `execution_strategy`，无需数据库迁移。
记录模式、理由、子目标数量、审核要求、决策来源、降级原因及规划失败状态。
Trace 详情页展示该步骤；当前用户启用 Langfuse 后上报 `execution.strategy`
节点，脱敏后保存决策。该步骤耗时包含分类及必要的计划生成。

`plan_started` 事件立即保存计划和待执行步骤，前端显示进度而不是审核卡片。
后续 `plan_progress` 更新步骤状态，原有消息元数据持久化保留计划及步骤，
因此仍可使用重试/跳过入口。`plan_proposal` 保留原有审核交互。

## 验证入口

- `lib/agent/runtime/execution-strategy.test.ts`：结构化决策、上下文边界、无效输出、超时及取消。
- `packages/application/src/chat/execution-routing.test.ts`：普通循环、自动计划、人工审核、已确认计划及失败禁用工具。
- `lib/agent/runtime/plan-proposal.test.ts`：复杂 Skill 可规划、规划失败不执行模板。
- `lib/agent/runtime/tool-confirmation.test.ts` 与 `plan-execution-runtime.test.ts`：普通循环和计划执行仍暂停等待具体工具确认。
- `apps/web/features/chat/model/chat-session-plan.test.ts`：自动计划事件、执行进度及持久化。

语义场景单测使用模拟的模型决策来验证接线和校验，不证明真实模型在这些场景中的分类准确率。
