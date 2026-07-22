# 文档分类索引

本索引按用途组织当前仍有效的文档。项目整体入口见 [README.md](./README.md)。

## 项目总览与路线图

| 文档 | 用途 |
|---|---|
| [project-modules-interview-guide.md](./interview/project-modules-interview-guide.md) | 当前项目各模块、真实代码边界与面试问答总览 |
| [enterprise-agent-roadmap.md](./agent/enterprise-agent-roadmap.md) | 唯一的 Agent 建设主路线图 |
| [agent-observability-improvement-plan.md](./agent/agent-observability-improvement-plan.md) | Trace、Eval、Replay、SLO 与数据治理专题规划 |

## Agent 学习与面试

| 文档 | 用途 |
|---|---|
| [agent-learning-plan.md](./agent/agent-learning-plan.md) | Agent 系统学习路线 |
| [agent-tool-calling-learning-roadmap.md](./agent/agent-tool-calling-learning-roadmap.md) | Tool Use、Registry、Router 与 Agent Loop 学习路线 |
| [tool-calling-hands-on-get-current-time.md](./agent/tool-calling-hands-on-get-current-time.md) | 最小工具调用实战 |
| [tool-calling-ui-calculator-multi-tool.md](./agent/tool-calling-ui-calculator-multi-tool.md) | 多工具调用与 UI 实战 |
| [memory-system-interview-questions.md](./agent/memory-system-interview-questions.md) | 记忆系统专题面试题 |
| [context-management-interview-questions.md](./agent/context-management-interview-questions.md) | 上下文工程专题面试题 |
| [harness-interview-questions.md](./agent/harness-interview-questions.md) | Harness 专题面试题 |
| [agent-evaluation-observability-interview-questions.md](./agent/agent-evaluation-observability-interview-questions.md) | 评估与可观测性专题面试题 |

## Agent 实现说明

| 文档 | 用途 |
|---|---|
| [context-token-budget.md](./agent/context-token-budget.md) | Token 预算、截断与压缩基础 |
| [layered-memory.md](./agent/layered-memory.md) | 分层记忆架构 |
| [memory-atomic-dual-write.md](./agent/memory-atomic-dual-write.md) | 长期与语义记忆原子写入 |
| [prompt-segmentation.md](./agent/prompt-segmentation.md) | Prompt 分段与预算策略 |
| [structured-event-protocol.md](./agent/structured-event-protocol.md) | Agent 到 UI 的结构化事件协议 |
| [observability-trace-eval.md](./agent/observability-trace-eval.md) | Trace 与 Eval 基础实现 |
| [trace-visualization.md](./agent/trace-visualization.md) | Trace UI |
| [usage-metrics-data-flow.md](./agent/usage-metrics-data-flow.md) | Usage 数据来源与费用口径 |
| [rag-eval.md](./agent/rag-eval.md) | RAG 评估闭环 |
| [scheduled-tasks.md](./agent/scheduled-tasks.md) | Scheduler 设计与实现 |
| [knowledge-search-toggle.md](./agent/knowledge-search-toggle.md) | 知识库检索开关 |

## Chat 与 RAG

| 文档 | 用途 |
|---|---|
| [00-streaming-chat.md](./chat/00-streaming-chat.md) | 流式对话基础 |
| [rag-implementation.md](./rag/rag-implementation.md) | RAG 基础实现 |
| [rag-retrieval-quality.md](./rag/rag-retrieval-quality.md) | 混合检索、RRF、MMR 与 Parent-Child |
| [agentic-rag-production.md](./rag/agentic-rag-production.md) | 当前 Agentic RAG、治理与运维边界 |
| [rag-interview-questions.md](./rag/rag-interview-questions.md) | RAG 专题面试题 |

## 数据库与 Schema

| 文档 | 用途 |
|---|---|
| [database-design.md](./database/database-design.md) | RAG 数据库设计 |
| [database-setup-guide.md](./database/database-setup-guide.md) | Supabase 初始化与验证 |
| [database-schema.sql](./schemas/database-schema.sql) | RAG 主 Schema |
| [database-schema-clean.sql](./schemas/database-schema-clean.sql) | RAG 重建脚本，会删除旧对象，执行前需确认环境 |
| [sessions-schema.sql](./schemas/sessions-schema.sql) | 会话 Schema |
| [semantic-memories-schema.sql](./schemas/semantic-memories-schema.sql) | 语义记忆 Schema |
| [scheduled-jobs-schema.sql](./schemas/scheduled-jobs-schema.sql) | 定时任务 Schema |
| [traces-schema.sql](./schemas/traces-schema.sql) | Trace Schema |
| [migrations/](./schemas/migrations/) | 按日期保存的增量迁移，必须保留顺序与历史 |

`schemas` 中其余专项 SQL（记忆、RLS、LeetCode）仍是可执行资产，不按普通说明文档清理。
