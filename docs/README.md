# 项目文档

`docs` 只保留三类内容：当前实现说明、仍有效的路线图，以及可复用的学习/面试材料。
一次性方案、已合并路线图和已修复的问题清单不再留档；历史需要从 Git 追溯。

## 推荐入口

| 目的 | 文档 |
|---|---|
| 理解整个项目 | [项目全模块总结与面试题](./interview/project-modules-interview-guide.md) |
| 查看后续建设优先级 | [企业级 Agent 路线图](./agent/roadmap/enterprise-agent-roadmap.md) |
| 理解当前 Agentic RAG | [Agentic RAG 生产化实现](./rag/agentic-rag-production.md) |
| 查找专题文档 | [文档分类索引](./docs-catalog.md) |
| 初始化或迁移数据库 | [数据库初始化指南](./database/database-setup-guide.md) / [schemas](./schemas/) |

## 维护规则

- 当前行为以源码、配置和测试为准，文档不替代代码事实。
- 一个主题只保留一份主路线图；新结论直接更新主文档。
- 功能落地后，把仍有价值的内容并入实现说明，删除一次性方案稿。
- 代码审查问题进入 issue/TODO 或主路线图，不长期保留独立问题清单。
- 新增、重命名或删除文档时同步更新 [docs-catalog.md](./docs-catalog.md)。
