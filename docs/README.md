# 学习记录

每实现一个功能，产出一份学习笔记，搞清楚"为什么这样做"而不只是"做出来了"。

## 笔记模板

每份笔记按以下结构组织：

```
# [功能名称]

## 这个功能解决什么问题
一句话说清楚。

## 核心概念
实现这个功能之前需要理解的基础知识。
不求全面，只写"不懂这个就写不出来"的部分。

## 工程实现
### 整体流程
用文字或伪代码描述实现思路（先做什么、再做什么）。

### 关键代码走读
标注关键代码片段，解释"这几行为什么这样写"。
不贴全部代码 — 完整实现去看源文件。

### 技术选型与决策
为什么选 A 不选 B？有什么权衡？

## 踩坑记录
实现过程中遇到的问题和解法。

## 延伸阅读
相关文档、文章、源码链接。
```

## 索引

| 编号 | 功能 | 文件 | 状态 |
|------|------|------|------|
| 00 | 流式对话（已有功能） | [00-streaming-chat.md](./chat/00-streaming-chat.md) | 待补 |
| 01 | Agent Loop 面试总结 | [agent-loop-interview-summary.md](./agent/agent-loop-interview-summary.md) | 已完成 |
| 02 | Agent 核心能力实现路线图 | [agent-core-capabilities-roadmap.md](./agent/agent-core-capabilities-roadmap.md) | 规划 |
| 03 | 上下文与 Token 预算管理（能力 1） | [context-token-budget.md](./agent/context-token-budget.md) | 已完成 |
| 04 | 可观测性 Trace 与 Eval（能力 3） | [observability-trace-eval.md](./agent/observability-trace-eval.md) | 已完成 |
| 05 | 分层记忆系统（能力 2） | [layered-memory.md](./agent/layered-memory.md) | 已完成（五层全部就位） |

> 后续每实现一个功能，在此表格追加一行。
