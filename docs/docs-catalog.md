# Docs 文档分类索引

本文档用于整理 `docs` 目录下现有文档的主题分类，方便后续查找、维护和扩展。

## 1. 总入口与文档规范

| 文件 | 类型 | 说明 |
|---|---|---|
| [README.md](./README.md) | 文档入口 / 写作规范 | 说明学习记录的写作模板和索引维护方式。 |
| [docs-catalog.md](./docs-catalog.md) | 分类索引 | 当前文档，用于按主题分类 `docs` 目录内容。 |

## 2. 聊天基础能力

| 文件 | 类型 | 说明 |
|---|---|---|
| [00-streaming-chat.md](./chat/00-streaming-chat.md) | 功能学习笔记 | 记录流式对话能力的核心概念、工程实现和踩坑记录。 |

## 3. Agent 学习路线与工具调用

| 文件 | 类型 | 说明 |
|---|---|---|
| [agent-learning-plan.md](./agent/agent-learning-plan.md) | 学习计划 | 基于 Agent-Learning-Hub，并结合当前项目制定的 Agent 系统学习路线。 |
| [agent-tool-calling-learning-roadmap.md](./agent/agent-tool-calling-learning-roadmap.md) | 学习路线图 | 面向 Agent 工具调用的系统学习路线，覆盖 Tool Use、Tool Registry、Tool Router、Agent Loop 等。 |
| [agent-loop-interview-summary.md](./agent/agent-loop-interview-summary.md) | 面试总结 / 实战复盘 | 从面试官和面试者两个视角总结当前项目的 Agent Loop 流程、核心问题和高分回答。 |
| [agent-core-capabilities-roadmap.md](./agent/agent-core-capabilities-roadmap.md) | 核心能力路线图 | 针对当前运行时真实缺口，按学习价值排序的 7 个核心能力（上下文/记忆/可观测/事件协议/规划/类型/MCP），含每项实现步骤和面试视角。 |
| [tool-calling-hands-on-get-current-time.md](./agent/tool-calling-hands-on-get-current-time.md) | 实战笔记 | 从 0 实现 `get_current_time` 工具，验证 Registry、Router、Tool、Result 最小闭环。 |
| [tool-calling-ui-calculator-multi-tool.md](./agent/tool-calling-ui-calculator-multi-tool.md) | 实战总结 | 记录工具调用 UI、`calculator` 工具、多工具调用和工具调用信息落库等能力。 |
| [context-token-budget.md](./agent/context-token-budget.md) | 实战笔记 | 能力 1：上下文与 Token 预算管理，含预算计数器、工具结果截断、滚动压缩三层防爆策略。 |
| [web-fetch-implementation-plan.md](./agent/web-fetch-implementation-plan.md) | 设计方案 | `web_fetch` 网页精读工具的完整实现方案，覆盖工具契约、SSRF 防护、正文提取、截断压缩、runtime 接入和测试策略。 |
| [usage-metrics-data-flow.md](./agent/usage-metrics-data-flow.md) | 实现文档 | `/usage` 模型用量页面的数据来源与计算口径，说明 DeepSeek/Anthropic cache 字段映射、费用估算、trace 聚合和旧数据兼容。 |
| [observability-trace-eval.md](./agent/observability-trace-eval.md) | 实战笔记 | 能力 3：可观测性 Trace（结构化调用树 + 落库）与 Eval（双轨 mock/live），含判别联合、依赖注入、vitest 踩坑。 |
| [agent-roadmap-final.md](./agent/agent-roadmap-final.md) | **成熟化路线图（最终整合版，主文档）** | 双主线：上半「看差距」（对标 mem0/Zep/GA/Claude Code/Anthropic/LangSmith + 真实行号 + 成本/面试杀伤力评分 + 面试话术），下半「看怎么建」（ContextPlan/MemoryWriteDecision/Trace 类型设计 + 模块树 + 里程碑 + Ops 指标 + 风险清单）。 |
| [maturity-benchmark-roadmap.md](./agent/maturity-benchmark-roadmap.md) | 对标差距分析（已整合至 final，存档） | 对标差距分析与分优先级改进项评分。内容已并入 `agent-roadmap-final.md` 上半部。 |
| [agent-engineering-roadmap.md](./agent/agent-engineering-roadmap.md) | 架构蓝图（已整合至 final，存档） | 四大控制面目标架构、核心类型设计、模块树、里程碑、Ops 与风险清单。内容已并入 `agent-roadmap-final.md` 下半部。 |

## 4. RAG 知识库系统

| 文件 | 类型 | 说明 |
|---|---|---|
| [rag-implementation.md](./rag/rag-implementation.md) | 实现文档 | 记录 RAG 个人知识库的系统概述、核心概念、技术栈、数据库设计和核心模块。 |
| [rag-optimization-roadmap.md](./rag/rag-optimization-roadmap.md) | 优化路线图 | 记录 RAG 系统短期、中期、长期优化方向，例如引用来源、批量同步、缓存、混合检索等。 |

## 5. 数据库设计与初始化

| 文件 | 类型 | 说明 |
|---|---|---|
| [database-design.md](./database/database-design.md) | 设计文档 | 说明 RAG 数据库的两表设计、更新检测、级联删除和问答式检索流程。 |
| [database-setup-guide.md](./database/database-setup-guide.md) | 初始化指南 | 说明如何通过 Supabase Dashboard 或命令行初始化数据库，并验证表、索引和函数。 |

## 6. SQL Schema

| 文件 | 类型 | 说明 |
|---|---|---|
| [database-schema.sql](./schemas/database-schema.sql) | SQL Schema | RAG 知识库数据库结构，包含 pgvector、Notion 页面元数据、文档分块和检索函数。 |
| [database-schema-clean.sql](./schemas/database-schema-clean.sql) | SQL Schema | 清理旧表并重新创建 RAG 相关表和函数的初始化脚本。 |
| [disable-rls.sql](./schemas/disable-rls.sql) | SQL Schema | 会话和消息表的 Row Level Security 策略配置脚本。 |
| [leetcode-practice-schema.sql](./schemas/leetcode-practice-schema.sql) | SQL Schema | LeetCode 热题 100 每日练习计划表结构，记录每天抽题结果和练习轮次。 |
| [leetcode-wrong-book-schema.sql](./schemas/leetcode-wrong-book-schema.sql) | SQL Schema | LeetCode 错题本表结构，记录错题、错因和复习计划。 |
| [sessions-schema.sql](./schemas/sessions-schema.sql) | SQL Schema | 会话和消息表结构，用于保存聊天会话与消息记录。 |
| [traces-schema.sql](./schemas/traces-schema.sql) | SQL Schema | Agent 运行 Trace 表（agent_traces），一行一次 runAgentLoop 执行轨迹，steps/metrics 存 JSONB。 |

## 7. 当前目录结构

当前 `docs` 已按主题拆分为：

```text
docs/
  README.md
  docs-catalog.md
  chat/
    00-streaming-chat.md
  agent/
    agent-learning-plan.md
    agent-tool-calling-learning-roadmap.md
    tool-calling-hands-on-get-current-time.md
    tool-calling-ui-calculator-multi-tool.md
  rag/
    rag-implementation.md
    rag-optimization-roadmap.md
  database/
    database-design.md
    database-setup-guide.md
  schemas/
    database-schema-clean.sql
    database-schema.sql
    disable-rls.sql
    leetcode-practice-schema.sql
    leetcode-wrong-book-schema.sql
    sessions-schema.sql
```

## 8. 推荐阅读顺序

如果你是从零理解当前项目，建议按这个顺序阅读：

1. [README.md](./README.md)
2. [00-streaming-chat.md](./chat/00-streaming-chat.md)
3. [agent-learning-plan.md](./agent/agent-learning-plan.md)
4. [agent-tool-calling-learning-roadmap.md](./agent/agent-tool-calling-learning-roadmap.md)
5. [tool-calling-hands-on-get-current-time.md](./agent/tool-calling-hands-on-get-current-time.md)
6. [tool-calling-ui-calculator-multi-tool.md](./agent/tool-calling-ui-calculator-multi-tool.md)
7. [database-design.md](./database/database-design.md)
8. [database-setup-guide.md](./database/database-setup-guide.md)
9. [rag-implementation.md](./rag/rag-implementation.md)
10. [rag-optimization-roadmap.md](./rag/rag-optimization-roadmap.md)
11. [database-schema.sql](./schemas/database-schema.sql)
12. [sessions-schema.sql](./schemas/sessions-schema.sql)
13. [disable-rls.sql](./schemas/disable-rls.sql)
14. [database-schema-clean.sql](./schemas/database-schema-clean.sql)
15. [leetcode-practice-schema.sql](./schemas/leetcode-practice-schema.sql)

## 9. 维护规则

新增文档时建议遵循：

- 新增学习笔记：同步更新 [README.md](./README.md) 和本分类索引。
- 新增 SQL：放入 `SQL Schema` 分类。
- 新增路线图：放入对应主题的 `学习路线` 或 `优化路线图` 分类。
- 新增实战总结：优先归入对应功能主题，例如 Agent、RAG、Chat、Database。
