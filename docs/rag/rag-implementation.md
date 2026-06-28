# RAG 个人知识库实现文档

## 当前形态

本项目的 RAG 是 **Agentic RAG**：知识库检索被包装成 `search_notes` 工具，模型在 Agent Loop 中按需调用，而不是每轮聊天都自动把 RAG 结果塞进 system prompt。

主链路：

```text
Notion 页面
  -> NotionClient 递归读取 blocks
  -> chunkText 结构化递归分块
  -> EmbeddingClient 生成 text-embedding-v4 向量
  -> Supabase/Postgres + pgvector 存储
  -> RAGRetriever 候选采样 + 混合评分 + MMR + 轻量精排
  -> search_notes 工具回传给 Agent
  -> Agent 基于工具结果回答并返回 sources
```

## 核心模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Notion 加载 | `lib/server/notion.ts` | 读取页面信息，递归展开 `has_children` blocks，转换成 Markdown-like 文本 |
| 分块 | `lib/server/chunking.ts` | 按标题/段落优先分块，超长块字符级兜底，输出 `headingPath` |
| 向量 | `lib/server/embedding.ts` | DashScope OpenAI-compatible API，模型 `text-embedding-v4` |
| 同步 | `lib/server/sync.ts` | 页面 hash 增量跳过，写入 `notion_pages` 和 `documents` |
| 检索 | `lib/server/retriever.ts` | pgvector 召回、关键词评分、候选采样、MMR、轻量 rerank |
| 工具 | `lib/agent/tools/search-notes.ts` | Agent 可调用的知识库搜索工具 |
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
  content_hash: string
  embedding_model: "text-embedding-v4"
  chunker_version: string
  last_edited_time: string
}
```

## 同步策略

`syncNotionPage(pageId)` 的流程：

1. 读取 Notion 页面完整文本。
2. 计算页面 `content_hash`。
3. 查询 `notion_pages.metadata`。
4. 如果 `content_hash`、`embedding_model`、`chunker_version` 都一致，返回 `status: "skipped"`。
5. 否则重新分块、批量 embedding、删除旧 chunks、插入新 chunks。

返回状态：

```ts
type SyncStatus = "created" | "updated" | "skipped" | "failed";
```

当前增量同步是页面级：页面没变则跳过；页面变了则整页重建。chunk 级 diff 建议等分块策略稳定后再做。

## 检索策略

`RAGRetriever.searchWithDebug(query)`：

1. Query rewrite：规则生成最多 3 个 query 变体。
2. pgvector 召回：默认最终 topK 的 4 倍候选，上限 50。
3. Keyword score：本地 token overlap，补足精确术语、错误码、API 名。
4. Score fusion：默认 `0.7 * vector + 0.3 * keyword`。
5. Lightweight rerank：标题/完整短语命中奖励。
6. MMR：默认开启，减少重复 chunk。

返回结果包含：

```ts
{
  similarity,
  vectorScore,
  keywordScore,
  combinedScore,
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
npm run rag:search "Notion 同步流程" -- --limit 10 --threshold 0.3
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
NOTION_API_KEY=
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DEEPSEEK_API_KEY=
```

## 已知边界

- 混合检索当前以 pgvector 召回为第一阶段，关键词分在应用层融合；schema 已预留 `search_vector` 和 GIN 索引，后续可升级为数据库双路召回。
- rerank 当前是轻量规则版本，不额外调用模型；后续可替换为 cross-encoder 或 LLM judge。
- `headingPath` 来自结构化分块，对 Markdown-like Notion 文本效果较好；PDF/网页导入需要各自的 loader。
