# Eval Datasets

所有静态评测用例统一放在此目录，并按能力分类：

- `agent.ts`：通用 Agent 行为、工具选择与完成状态。
- `rag.ts`：知识库检索命中、负例与混淆项。
- `retrieval-routing.ts`：no_retrieval / knowledge / web / both 路由。
- `memory.ts`：记忆召回门控、写入决策、存储语义与融合 A/B。

执行器、指标、Langfuse 同步适配器和 Vitest 文件仍放在上一级 `eval/`；它们消费
测试集，但本身不是测试数据。新增测试用例时应写入对应功能文件，不要在脚本或
测试文件中维护第二份 case 数组。
