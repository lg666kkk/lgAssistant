# RAG 个人知识库实现文档

## 当前形态

本项目的 RAG 是 **Agentic RAG**：知识库检索被包装成 `search_notes` 工具，模型在 Agent Loop 中按需调用，而不是每轮聊天都自动把 RAG 结果塞进 system prompt。

主链路：

```text
Notion 页面
  -> NotionClient 递归读取 blocks
  -> chunkText 结构 + token 感知分块
  -> EmbeddingClient 生成 text-embedding-v4 向量
  -> Supabase/Postgres + pgvector 存储
  -> RAGRetriever multi-query 并行召回 + RRF + 条件精排 + 向量 MMR
  -> search_notes 工具回传给 Agent
  -> Agent 基于工具结果回答并返回 sources
```

## 核心模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Notion 加载 | `lib/knowledge/notion.ts` | 读取页面信息，递归展开 `has_children` blocks，转换成 Markdown-like 文本 |
| 分块 | `lib/knowledge/chunking.ts` | 标题/段落/代码/表格结构感知，字符与 token 双上限，输出 `headingPath/kind/tokenCount` |
| 向量 | `lib/knowledge/embedding.ts` | DashScope OpenAI-compatible API，模型 `text-embedding-v4` |
| 同步 | `lib/knowledge/sync.ts` | 页面 hash 增量跳过，写入 `notion_pages` 和 `documents` |
| 检索 | `lib/knowledge/retriever.ts` | standalone/multi-query、向量和关键词并行召回、RRF/校准加权、条件精排、向量 MMR |
| 精排 | `lib/knowledge/reranker.ts` | 可选 HTTP Cross-Encoder 适配器、返回完整性校验和失败降级 |
| 工具 | `lib/agent/tools/search-notes.ts` | TopK、parent 去重和最终上下文 token 预算 |
| CLI | `scripts/rag-sync.ts` / `scripts/rag-search.ts` | 本地同步和检索验证 |

## 数据库结构

当前 schema 见 `docs/schemas/database-schema.sql`。

核心表：

```sql
notion_pages (
  page_id TEXT PRIMARY KEY,
  page_title TEXT NOT NULL,
  page_url TEXT NOT NULL,
  last_edited_time TIMESTAMPTZ NOT NULL,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  chunk_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
)

documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id TEXT NOT NULL REFERENCES notion_pages(page_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

`documents.metadata` 约定字段：

```ts
{
  page_id: string
  page_title: string
  page_url: string
  chunk_index: number
  start_char: number
  end_char: number
  heading_path: string[]
  chunk_kind: "text" | "code" | "table"
  chunk_token_count: number
  parent_content: string
  parent_key: string
  parent_start_char: number
  parent_end_char: number
  parent_child_count: number
  content_hash: string
  embedding_model: "text-embedding-v4"
  chunker_version: string
  last_edited_time: string
}
```

## 同步策略

`syncNotionPage(pageId, { userId })` 的流程：

1. 读取 Notion 页面完整文本。
2. 计算页面 `content_hash`。
3. 查询 `notion_pages.metadata`。
4. 如果 `content_hash`、`embedding_model`、`chunker_version` 都一致，返回 `status: "skipped"`。
5. 否则重新分块，并按每批 10 条生成 embedding。每批根据 provider `index` 校验和重排，检查返回数量、index 唯一性/范围、空向量、1024 维度、有限数和零向量；瞬时错误或不完整响应最多重试 2 次。
6. 调用 `sync_notion_page_documents_atomic`，在单个 PostgreSQL 事务内更新页面元数据、删除旧 chunks、插入并校验新 chunks。

同一用户、同一页面的事务通过 advisory lock 串行执行。事务提交前，其他查询仍看到旧索引；任一步失败都会整体回滚，不会暴露空索引或半量 chunks。部署前需要先执行 `docs/schemas/migrations/20260717-rag-atomic-sync.sql`。

每个 embedding 批次根据 `model + page/version scope + batch inputs` 生成稳定的 `Idempotency-Key`，同一批次重试复用该 key；同步 Trace 会记录批次、attempt、provider indexes、是否发生重排和失败原因。该请求键保证客户端重试身份稳定，但 provider 是否免除重复计费取决于其是否支持这个 header。所有批次通过后才会进入数据库原子替换。

返回状态：

```ts
type SyncStatus = "created" | "updated" | "skipped" | "failed";
```

当前增量同步是页面级：页面没变则跳过；页面变了则整页重建。chunk 级 diff 建议等分块策略稳定后再做。

## 检索策略

`RAGRetriever.searchWithDebug(query)`：

1. Standalone query：多轮指代 query 使用前文补全；工具 schema 同时要求模型主动补全实体。
2. Query rewrite：规则生成最多 3 个 query 变体，全部参与向量召回。
3. Parallel recall：`embedding + multi-query pgvector` 与关键词 RPC 并行执行。
4. Score fusion：默认 Weighted RRF；保留校准加权策略用于消融，并按 query 类型动态分配权重。
5. Rerank：规则版始终作为快速路径；困难 query 可条件启用 Cross-Encoder。
6. MMR：优先使用候选 embedding 余弦相似度；迁移未部署时降级为文本 Jaccard。
7. Parent-child：child 用于检索，按 parent 去重后投喂更完整段落。
8. Budget：最终 TopK 5、融合候选池 50、工具上下文 2400 tokens。

返回结果包含：

```ts
{
  similarity,
  vectorScore,
  keywordScore,
  combinedScore,
  rrfScore,
  crossEncoderScore,
  rerankScore,
  headingPath,
  metadata
}
```

## 使用方式

同步 Notion 页面：

```bash
npm run rag:sync <notion_page_id> [...more_page_ids]
```

本地检索验证：

```bash
npm run rag:search "怎么做 RAG 检索优化"
npm run rag:search "Notion 同步流程" -- --limit 5 --threshold 0.4
```

### LLM 编译知识库

RAG 的 `notion_pages/documents` 作为 raw/source of truth。编译知识库在其上生成结构化 wiki 页面和概念关系：

```bash
npm run wiki:compile
npm run wiki:compile -- --force
npm run wiki:compile <notion_page_id>
```

也可以在 `/knowledge` 页面点击「编译 Wiki」查看实时编译事件。

数据库表：

- `compiled_wiki_pages`：LLM 编译后的 wiki 页面
- `compiled_wiki_edges`：页面和概念之间的关系边

首次使用前需要重新执行 `docs/schemas/database-schema.sql`，创建上述两张表。

应用内调用：

```text
用户问题 -> Agent Loop -> 模型决定调用 search_notes -> RAGRetriever -> tool_result -> 模型回答
```

## 环境变量

```env
# Notion Integration Token 由当前用户在「连接 > 知识库 > 数据源」中配置。
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DEEPSEEK_API_KEY=
RAG_FUSION_STRATEGY=rrf
RAG_CROSS_ENCODER_ENABLED=false
RAG_CROSS_ENCODER_MODE=conditional
RAG_RERANK_URL=
RAG_RERANK_MODEL=
RAG_RERANK_API_KEY=
```

## 已知边界

- 向量与关键词已经是数据库双路召回，并在应用层执行 RRF/校准加权融合。
- Cross-Encoder 默认关闭；没有 provider、调用失败或返回格式错误时使用规则 rerank。
- parent 当前重复保存在 child metadata 中；数据规模扩大后应拆为独立 parent 表。
- semantic chunking 尚未默认启用，当前是结构、token、句子/换行边界感知。
- `headingPath` 来自结构化分块，对 Markdown-like Notion 文本效果较好；PDF/网页导入需要各自的 loader。

完整设计、迁移和消融方法见 `docs/rag/rag-retrieval-quality.md`。
