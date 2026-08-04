# 文档分类索引

本索引按功能组织当前文档。项目入口见 [README.md](./README.md)。

## 面试题

所有项目与专题面试材料统一放在 `interview/`。

| 文档 | 用途 |
|---|---|
| [project-modules-interview-guide.md](./interview/project-modules-interview-guide.md) | 项目模块、代码边界与综合面试题 |
| [rag-interview-questions.md](./interview/rag-interview-questions.md) | RAG 专题面试题 |
| [memory-system-interview-questions.md](./interview/memory-system-interview-questions.md) | 记忆系统专题面试题 |
| [context-management-interview-questions.md](./interview/context-management-interview-questions.md) | 上下文工程专题面试题 |
| [harness-interview-questions.md](./interview/harness-interview-questions.md) | Harness 专题面试题 |
| [agent-evaluation-observability-interview-questions.md](./interview/agent-evaluation-observability-interview-questions.md) | 评估与可观测性专题面试题 |

## Agent 路线图

| 文档 | 用途 |
|---|---|
| [enterprise-agent-roadmap.md](./agent/roadmap/enterprise-agent-roadmap.md) | 唯一的 Agent 建设主路线图 |

## Agent 学习

| 文档 | 用途 |
|---|---|
| [agent-learning-plan.md](./agent/learning/agent-learning-plan.md) | Agent 系统学习路线 |
| [agent-tool-calling-learning-roadmap.md](./agent/learning/agent-tool-calling-learning-roadmap.md) | Tool Use、Registry、Router 与 Agent Loop 学习路线 |
| [frontend-to-ai-infra-roadmap.md](./agent/learning/frontend-to-ai-infra-roadmap.md) | 前端转型 Agent Infra / AI Platform 的岗位地图与 24 周实践路线 |

## Agent Runtime

| 文档 | 用途 |
|---|---|
| [structured-event-protocol.md](./agent/runtime/structured-event-protocol.md) | Agent 到 UI 的结构化事件协议 |
| [model-stream-parsing.md](./agent/runtime/model-stream-parsing.md) | 模型流式输出的四层解析链路与 DEBUG_AI_STREAM 观测开关 |

## Agent 工具

| 文档 | 用途 |
|---|---|
| [tool-calling-hands-on-get-current-time.md](./agent/tools/tool-calling-hands-on-get-current-time.md) | 最小工具调用实战 |
| [tool-calling-ui-calculator-multi-tool.md](./agent/tools/tool-calling-ui-calculator-multi-tool.md) | 多工具调用与 UI 实战 |
| [knowledge-search-toggle.md](./agent/tools/knowledge-search-toggle.md) | 知识库检索开关 |

## 上下文工程

| 文档 | 用途 |
|---|---|
| [context-token-budget.md](./agent/context/context-token-budget.md) | Token 预算、截断与压缩基础 |
| [prompt-segmentation.md](./agent/context/prompt-segmentation.md) | Prompt 分段与预算策略 |

## 记忆系统

| 文档 | 用途 |
|---|---|
| [layered-memory.md](./agent/memory/layered-memory.md) | 分层记忆架构 |
| [memory-atomic-dual-write.md](./agent/memory/memory-atomic-dual-write.md) | 长期与语义记忆原子写入 |
| [memory-conflict-and-recall.md](./agent/memory/memory-conflict-and-recall.md) | 记忆冲突治理：历史表、硬删除、关键词召回通道 |

## 可观测性与评估

| 文档 | 用途 |
|---|---|
| [agent-observability-improvement-plan.md](./agent/observability/agent-observability-improvement-plan.md) | Trace、Eval、Replay、SLO 与数据治理规划 |
| [observability-trace-eval.md](./agent/observability/observability-trace-eval.md) | Trace 与 Eval 基础实现 |
| [trace-visualization.md](./agent/observability/trace-visualization.md) | Trace UI |
| [usage-metrics-data-flow.md](./agent/observability/usage-metrics-data-flow.md) | Usage 数据来源与费用口径 |
| [span-chinese-labels.md](./agent/observability/span-chinese-labels.md) | Langfuse span 的中文作用标识 spanLabel |

## 定时任务

| 文档 | 用途 |
|---|---|
| [scheduled-tasks.md](./agent/scheduler/scheduled-tasks.md) | Scheduler 设计与实现 |

## Chat 与 RAG

| 文档 | 用途 |
|---|---|
| [00-streaming-chat.md](./chat/00-streaming-chat.md) | 流式对话基础 |
| [rag-implementation.md](./rag/rag-implementation.md) | RAG 基础实现 |
| [rag-retrieval-quality.md](./rag/rag-retrieval-quality.md) | 混合检索、RRF、MMR 与 Parent-Child |
| [agentic-rag-production.md](./rag/agentic-rag-production.md) | Agentic RAG、治理与运维边界 |
| [rag-eval.md](./rag/rag-eval.md) | RAG 评估闭环 |
| [web-toggle-vs-route.md](./rag/web-toggle-vs-route.md) | 联网开关是权限边界，route 只表达优先级 |

## 数据库与 Schema

| 文档 | 用途 |
|---|---|
| [database-design.md](./database/database-design.md) | RAG 数据库设计 |
| [database-setup-guide.md](./database/database-setup-guide.md) | Supabase 初始化与验证 |
| [database-schema.sql](./schemas/database-schema.sql) | RAG 主 Schema |
| [database-schema-clean.sql](./schemas/database-schema-clean.sql) | RAG 重建脚本，执行前需确认环境 |
| [sessions-schema.sql](./schemas/sessions-schema.sql) | 会话 Schema |
| [semantic-memories-schema.sql](./schemas/semantic-memories-schema.sql) | 语义记忆 Schema |
| [scheduled-jobs-schema.sql](./schemas/scheduled-jobs-schema.sql) | 定时任务 Schema |
| [traces-schema.sql](./schemas/traces-schema.sql) | Trace Schema |
| [migrations/](./schemas/migrations/) | 按日期保存的增量迁移 |

`schemas` 中其余专项 SQL 也是可执行资产，不按普通说明文档清理。
