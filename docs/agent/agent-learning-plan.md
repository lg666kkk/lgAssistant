# Agent 学习计划

基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 整理，并结合当前 `personal-assistant` 项目的实际进度制定。

## 总目标

最终做出一个真正可用的个人 Agent：

- 能聊天
- 能调用工具
- 能查知识库
- 能记忆用户偏好
- 能执行日程、练题、搜索等任务
- 有日志、权限、安全边界
- 有评测用例，知道它什么时候失败

建议周期：6-8 周。

---

## 第 0 阶段：理解 Agent 是什么

时间：1-2 天

### 学习目标

理解以下概念的区别：

- Chatbot：只回答问题，不主动做事。
- Workflow：固定流程，例如输入、搜索、总结、输出。
- Agent：可以根据目标自己决定是否调用工具、调用哪个工具、调用几次，以及是否继续观察结果。
- Multi-Agent：多个 Agent 分工协作，不是简单让几个模型互相聊天。

### 推荐阅读

- Anthropic: Building effective agents
- OpenAI: A practical guide to building agents

### 阶段产出

写一页笔记，回答：

```text
我的 personal-assistant 为什么需要 Agent，而不是普通 workflow？
```

可以从这些角度回答：

- 需要动态选择工具
- 用户请求不固定
- 可能需要多轮观察和执行
- 需要记忆和上下文
- 需要处理工具失败

---

## 第 1 阶段：最小 Agent Loop

时间：3-5 天

当前项目已经有 Agent Loop 雏形：`/api/chat` 会把工具列表传给模型，然后执行工具，再把结果喂回模型。

### 学习目标

掌握 Agent Loop 的基本结构：

```text
用户输入
  ↓
LLM 思考
  ↓
决定是否调用工具
  ↓
执行工具
  ↓
把工具结果返回给 LLM
  ↓
LLM 输出最终答案
```

### 重点概念

- Tool Registry：工具注册中心
- Tool Schema：告诉模型工具叫什么、参数是什么
- Tool Result：工具执行后的返回结果
- Max Iterations：防止模型无限调用工具
- Error Handling：工具失败后如何反馈给模型

### 项目练习

- 看懂 `lib/agent/tools/builtin.ts`
- 看懂 `lib/agent/tools/tool-router.ts`
- 给工具调用加统一日志：工具名、输入参数、是否成功、耗时、错误信息

### 阶段产出

能够完整解释下面这个流程：

```text
用户问：“今天 LeetCode 练什么？”
模型选择 get_daily_leetcode_practice
工具返回 5 道题
模型组织自然语言答案
```

---

## 第 2 阶段：Tool Use、RAG、Memory

时间：1-2 周

这是当前项目最应该重点学习的阶段。

### 学习目标

掌握：

- 工具调用
- RAG：chunk、embedding、retrieve、answer with citations
- Memory：短期上下文、会话记忆、长期记忆、用户偏好

### 项目练习 1：增强 LeetCode 工具

给 `get_daily_leetcode_practice` 增加参数：

```ts
{
  difficulty?: "简单" | "中等" | "困难";
  tags?: string[];
}
```

示例：

```text
今天给我 5 道动态规划题
```

工具可以优先从 `动态规划` 标签里抽题。

### 项目练习 2：增强结构化结果

工具除了返回自然语言，也应保证 `data` 可以被前端使用：

```ts
{
  date: "2026-05-21",
  problems: [
    {
      id: 543,
      title: "二叉树的直径",
      difficulty: "简单",
      tags: ["树", "DFS"],
      url: "..."
    }
  ]
}
```

### 项目练习 3：RAG 回答必须带来源

例如用户问：

```text
我的 Notion 里有没有 Agent 相关笔记？
```

回答时需要带来源：

```text
来源：
1. xxx 页面
2. xxx 页面
```

### 阶段产出

做一个资料研究助手：

```text
输入主题后，自动搜索、筛选、总结，并输出引用链接。
```

---

## 第 3 阶段：研究一个现代 Agent Harness

时间：1 周

不要贪多，选一个现代 Agent 系统深入看。

### 推荐选择

优先选择：

- Claude Code
- LangGraph
- hello-agents

重点不是框架 API，而是学习它们怎么组织：

- 工具
- 权限
- 上下文
- 状态
- 日志
- trace
- 子任务

### 研究问题

看一个 Agent 项目时，重点回答：

- Agent loop 在哪里？
- 工具在哪里注册？
- 工具参数怎么校验？
- 危险操作怎么确认？
- 上下文太长怎么办？
- 失败怎么重试？
- 日志怎么追踪？

### 项目练习

完善工具系统里的权限层：

```ts
riskLevel: "safe" | "confirm" | "dangerous"
```

示例：

- `get_current_time`：safe
- `get_daily_leetcode_practice`：safe
- `create_todo`：confirm
- `delete_file`：dangerous

### 阶段产出

写一份项目架构说明：

```text
我的 personal-assistant Agent 架构说明
```

内容包括：

- Agent loop
- Tool registry
- Tool router
- Memory
- RAG
- 风险控制
- 已知问题

---

## 第 4 阶段：Multi-Agent 是协调，不是魔法

时间：3-5 天

Multi-Agent 不是让多个角色聊天，而是任务协调。

### 学习目标

理解常见角色：

- Planner：拆任务
- Executor：执行工具
- Reviewer：检查结果
- Router：判断交给哪个能力

### 项目练习

做一个简单三段式流程：

```text
research -> write -> review
```

示例请求：

```text
帮我研究一下 Agent Memory，并写一篇学习笔记
```

流程：

```text
Research Agent：搜索资料
Write Agent：生成笔记
Review Agent：检查是否有来源、是否幻觉、是否结构清晰
```

### 注意原则

```text
单 Agent 能解决，就不要多 Agent。
Workflow 能解决，就不要 Agent。
脚本能解决，就不要 LLM。
```

---

## 第 5 阶段：Skills、MCP、能力封装

时间：1 周

这个阶段适合长期维护个人助理。

### 学习目标

理解：

- Tool：一个可调用函数
- Skill：一套完成任务的方法论和流程
- MCP：外部工具和数据源接入协议

### 示例

`get_daily_leetcode_practice` 是 tool。

但“每日算法训练教练”可以是 skill：

```text
1. 获取今天 5 道题
2. 让用户选择一道
3. 讲解题意
4. 引导思路
5. 让用户写代码
6. 帮用户 review
7. 记录错题
```

### 项目练习

做一个 `leetcode-coach` skill：

```text
什么时候触发：
用户说刷题、LeetCode、算法、讲题、每日练习

执行步骤：
1. 获取今日题目
2. 让用户选题
3. 先讲题意
4. 不直接给答案，先问思路
5. 根据回答逐步提示
6. 最后总结模板和复杂度
```

### 阶段产出

一个可复用 skill 文档：

```text
skills/leetcode-coach/SKILL.md
```

---

## 第 6 阶段：Browser Agent

时间：1 周，可选

### 学习目标

掌握：

- Playwright
- 页面截图
- DOM 提取
- 点击、输入、等待
- 错误恢复
- 安全边界

### 项目练习

做一个只访问公开网页的 Browser Agent：

```text
输入一个网页 URL
自动打开
提取标题、正文、链接
生成摘要
```

### 安全边界

不要做：

- 自动登录敏感账号
- 绕过平台限制
- 自动购买
- 自动发帖
- 自动删除内容

---

## 第 7 阶段：评测、日志、安全

时间：1 周

Agent 不应该只靠感觉判断好不好，要有测试集。

### 建议测试表结构

```text
任务 | 期望工具 | 期望结果 | 实际结果 | 是否成功 | 失败原因
```

### 示例测试任务

```text
今天 LeetCode 练什么？
期望工具：get_daily_leetcode_practice
期望结果：返回 5 道题
```

```text
帮我搜索 Notion 里的 Agent 笔记
期望工具：search_notes
期望结果：返回带来源的摘要
```

### 需要记录

- 工具调用次数
- 成功率
- 失败原因
- 响应时间
- token 成本
- 是否误调用工具
- 是否重复调用工具

### 阶段产出

至少 20 条 Agent 测试用例。

---

## 第 8 阶段：发布一个真正可用的 Agent

时间：1-2 周

最终目标不是学习完，而是 ship。

### 最终项目方向

```text
个人学习助理 Agent
```

可以包含：

- 每日 LeetCode 练习
- 算法题讲解
- Notion 知识库检索
- 待办创建
- 学习计划生成
- 长期记忆
- 工具调用日志
- 安全确认机制

### 必备内容

- README
- 环境变量说明
- 数据库初始化 SQL
- 工具扩展指南
- 示例问题
- 已知限制
- 测试用例
- 部署说明

---

## 6 周执行安排

### 第 1 周：Agent 基础 + 最小 Loop

学习：

- chatbot / workflow / agent 区别
- tool call 流程

实践：

- 读懂当前 `/api/chat`
- 读懂 `tool-router`
- 画出自己的 Agent loop 图

产出：

- 一篇架构笔记

### 第 2 周：工具系统强化

学习：

- function calling
- schema
- tool result
- risk level

实践：

- 完善 LeetCode 工具
- 增加工具调用日志
- 增加工具错误分类

产出：

- 一个稳定的工具系统

### 第 3 周：RAG 和 Memory

学习：

- chunk
- embedding
- retrieve
- citations
- memory 分类

实践：

- 优化 `search_notes`
- 回答中展示来源
- 加用户偏好记忆

产出：

- 知识库问答助手

### 第 4 周：Agent Harness 和权限

学习：

- Claude Code / LangGraph / hello-agents 选一个深入看

实践：

- 给 Agent 加权限确认
- 加 trace 日志
- 加最大工具调用次数

产出：

- 可调试 Agent Demo

### 第 5 周：Skill 和学习助理

学习：

- Tool vs Skill vs MCP

实践：

- 写 `leetcode-coach` skill
- 做算法题引导流程
- 记录错题和掌握程度

产出：

- LeetCode 学习教练

### 第 6 周：评测和发布

学习：

- eval
- observability
- safety

实践：

- 写 20 条测试任务
- 统计成功率
- 修复最常见失败

产出：

- 一个别人能 clone 跑起来的 personal-assistant Agent

---

## 当前最该做的 3 件事

### 1. 画清楚自己的 Agent Loop

```text
User
 ↓
/api/chat
 ↓
LLM
 ↓
tool_use?
 ↓
ToolRouter
 ↓
ToolResult
 ↓
LLM final answer
```

### 2. 把 LeetCode 工具做成学习闭环

当前已有：

```text
每日随机 5 道
```

下一步做：

```text
选一道题 -> 讲题 -> 提示 -> 写代码 -> 复盘 -> 记录掌握情况
```

### 3. 加 Eval，不要只靠手测

先写 10 条：

```text
1. 今天 LeetCode 练什么？
2. 给我一道二叉树题
3. 搜索我的 Agent 笔记
4. 帮我创建明天刷题待办
5. 解释二叉树的直径
```

记录每次是否成功。

---

## 总结

最适合当前项目的路线是：

```text
最小 Agent Loop
  → 工具调用
  → RAG / Memory
  → 权限和日志
  → Skill 封装
  → Eval
  → 发布一个真正能用的个人助理
```

当前项目已经处于 Stage 1 - Stage 2 之间。下一步最值得做的是：

```text
把 LeetCode 每日练习工具升级成“算法学习教练 Agent”
```
