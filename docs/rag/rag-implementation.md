# RAG 个人知识库实现文档

## 一、系统概述

本项目实现了一个基于 RAG (Retrieval-Augmented Generation) 的个人知识库助手，能够：
- 从 Notion 同步知识内容
- 将内容转换为向量存储到数据库
- 在用户提问时自动检索相关知识
- 将检索结果注入到 LLM 上下文中，实现基于知识库的问答

## 二、核心概念

### 2.1 向量模型 (Embedding Model)
- **作用**：将文本转换为 1024 维的数值向量
- **模型**：text-embedding-v4
- **原理**：语义相似的文本会被映射到向量空间中相近的位置

### 2.2 向量相似度搜索
- **算法**：余弦相似度 (Cosine Similarity)
- **范围**：-1 到 1，值越大越相似
- **阈值**：0.5（可调整，0.7 更严格，0.3 更宽松）

### 2.3 文本分块 (Chunking)
- **目的**：将长文本切分成适合检索的小块
- **参数**：
  - `chunkSize`: 500 字符（每块大小）
  - `overlap`: 50 字符（相邻块重叠部分，防止语义截断）
  - `minChunkSize`: 100 字符（最小块大小）

### 2.4 RAG 架构
```
用户提问 → 向量化 → 检索相似文档 → 注入 LLM 上下文 → 生成回答
```

## 三、技术栈

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 前端框架 | Next.js 14 (App Router) | React 服务端组件 + 流式响应 |
| 数据库 | Supabase (PostgreSQL) | 托管的 PostgreSQL + pgvector 扩展 |
| 向量搜索 | pgvector + HNSW 索引 | 高性能向量相似度搜索 |
| 向量模型 | text-embedding-v4 | 1024 维向量 |
| LLM | DeepSeek V4 Pro | 对话生成 |
| 知识源 | Notion API | 页面内容同步 |

## 四、数据库设计

### 4.1 表结构

#### notion_pages 表（元数据）
```sql
CREATE TABLE notion_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id TEXT UNIQUE NOT NULL,           -- Notion 页面 ID
    title TEXT NOT NULL,                    -- 页面标题
    last_edited_time TIMESTAMPTZ NOT NULL,  -- 最后编辑时间（用于检测更新）
    synced_at TIMESTAMPTZ DEFAULT NOW(),    -- 同步时间
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### documents 表（文档块 + 向量）
```sql
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notion_page_id UUID REFERENCES notion_pages(id) ON DELETE CASCADE,
    content TEXT NOT NULL,                  -- 文本内容
    embedding VECTOR(1024),                 -- 向量（1024 维）
    metadata JSONB,                         -- 元数据（标题、位置等）
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW 索引（加速向量搜索）
CREATE INDEX documents_embedding_idx ON documents 
USING hnsw (embedding vector_cosine_ops);
```

### 4.2 向量搜索函数
```sql
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding VECTOR(1024),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.content,
        d.metadata,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM documents d
    WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

## 五、核心模块

### 5.1 向量模型客户端 (`lib/server/embedding.ts`)

```typescript
export class EmbeddingClient {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  // 单个文本向量化
  async embedSingle(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: "text-embedding-v4",
      input: text
    });
    return response.data[0].embedding;
  }

  // 批量向量化（提高效率）
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: "text-embedding-v4",
      input: texts
    });
    return response.data.map(item => item.embedding);
  }
}
```

### 5.2 Notion 客户端 (`lib/server/notion.ts`)

```typescript
export class NotionClient {
  private client: Client;

  constructor() {
    this.client = new Client({
      auth: process.env.NOTION_API_KEY,
    });
  }

  // 获取页面完整内容
  async getPage(pageId: string) {
    const [info, content] = await Promise.all([
      this.getPageInfo(pageId),
      this.getPageContent(pageId),
    ]);
    return { ...info, content };
  }

  // 递归读取所有块（包括子块）
  private async getPageContent(blockId: string): Promise<string> {
    const blocks = await this.client.blocks.children.list({ block_id: blockId });
    let content = '';
    
    for (const block of blocks.results) {
      content += this.blockToText(block) + '\n';
      
      // 递归处理子块
      if (block.has_children) {
        content += await this.getPageContent(block.id);
      }
    }
    
    return content;
  }
}
```

### 5.3 文本分块 (`lib/server/chunking.ts`)

```typescript
export interface ChunkOptions {
  chunkSize?: number;    // 每块大小（默认 500）
  overlap?: number;      // 重叠字符数（默认 50）
  minChunkSize?: number; // 最小块大小（默认 100）
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const { chunkSize = 500, overlap = 50, minChunkSize = 100 } = options;
  const chunks: TextChunk[] = [];
  let startChar = 0;

  while (startChar < text.length) {
    let endChar = Math.min(startChar + chunkSize, text.length);

    // 智能边界检测：优先在句子边界切分
    if (endChar < text.length) {
      const sentenceEnd = text.slice(startChar, endChar).lastIndexOf('。');
      if (sentenceEnd > chunkSize * 0.5) {
        endChar = startChar + sentenceEnd + 1;
      }
    }

    const chunkText = text.slice(startChar, endChar).trim();
    
    if (chunkText.length >= minChunkSize) {
      chunks.push({
        text: chunkText,
        startChar,
        endChar,
        index: chunks.length,
      });
    }

    // 计算下一个起点（带重叠）
    const nextStart = endChar - overlap;
    if (nextStart <= startChar) {
      startChar = endChar; // 防止死循环
    } else {
      startChar = nextStart;
    }
  }

  return chunks;
}
```

### 5.4 同步管道 (`lib/server/sync.ts`)

```typescript
export async function syncNotionPage(pageId: string): Promise<SyncResult> {
  const notionClient = new NotionClient();
  const embeddingClient = new EmbeddingClient();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. 从 Notion 读取页面
  const page = await notionClient.getPage(pageId);

  // 2. 检查是否需要更新
  const { data: existingPage } = await supabase
    .from('notion_pages')
    .select('last_edited_time')
    .eq('page_id', pageId)
    .single();

  if (existingPage && existingPage.last_edited_time === page.lastEditedTime) {
    return { success: true, message: '页面未更新，跳过同步' };
  }

  // 3. 文本分块
  const chunks = chunkText(page.content, {
    chunkSize: 500,
    overlap: 50,
  });

  // 4. 批量向量化
  const embeddings = await embeddingClient.embedBatch(
    chunks.map(c => c.text)
  );

  // 5. 保存到数据库（事务）
  // 5.1 插入/更新页面元数据
  const { data: pageRecord } = await supabase
    .from('notion_pages')
    .upsert({
      page_id: pageId,
      title: page.title,
      last_edited_time: page.lastEditedTime,
      synced_at: new Date().toISOString(),
    })
    .select()
    .single();

  // 5.2 删除旧的文档块
  await supabase
    .from('documents')
    .delete()
    .eq('notion_page_id', pageRecord.id);

  // 5.3 插入新的文档块
  const documents = chunks.map((chunk, i) => ({
    notion_page_id: pageRecord.id,
    content: chunk.text,
    embedding: embeddings[i],
    metadata: {
      title: page.title,
      chunk_index: i,
      start_char: chunk.startChar,
      end_char: chunk.endChar,
    },
  }));

  await supabase.from('documents').insert(documents);

  return {
    success: true,
    message: `成功同步 ${chunks.length} 个文档块`,
  };
}
```

### 5.5 检索器 (`lib/server/retriever.ts`)

```typescript
export class RAGRetriever {
  private supabase: SupabaseClient;
  private embeddingClient: EmbeddingClient;

  constructor() {
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    this.embeddingClient = new EmbeddingClient();
  }

  // 语义搜索
  async search(query: string, options = {}) {
    const { matchThreshold = 0.5, matchCount = 5 } = options;

    // 1. 将问题向量化
    const queryEmbedding = await this.embeddingClient.embedSingle(query);

    // 2. 调用数据库函数进行向量搜索
    const { data, error } = await this.supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) throw error;
    return data || [];
  }

  // 格式化检索结果为 LLM 上下文
  formatContext(results: any[]): string {
    return results
      .map((doc, i) => {
        const title = doc.metadata?.title || '未知文档';
        return `[文档 ${i + 1}] ${title}\n${doc.content}\n相似度: ${(doc.similarity * 100).toFixed(2)}%`;
      })
      .join('\n\n---\n\n');
  }
}
```

### 5.6 聊天 API 集成 (`app/api/chat/route.ts`)

```typescript
export async function POST(req: Request) {
  const { messages } = await req.json();

  // 1. RAG 检索：获取用户最后一条消息
  const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
  let ragContext = '';

  if (lastUserMessage) {
    try {
      const retriever = new RAGRetriever();
      const results = await retriever.search(lastUserMessage.content, {
        matchThreshold: 0.5,
        matchCount: 3,
      });

      if (results.length > 0) {
        ragContext = retriever.formatContext(results);
        console.log(`[RAG] 找到 ${results.length} 个相关文档`);
      }
    } catch (error) {
      console.error('[RAG] 检索失败:', error);
      // 检索失败不影响正常对话
    }
  }

  // 2. 如果有 RAG 上下文，注入到消息中
  const enhancedMessages = ragContext
    ? [
        {
          role: 'user',
          content: `# 知识库参考资料

${ragContext}

---

# 用户问题
${lastUserMessage.content}

# 回答要求
1. **优先使用上述知识库内容回答**
2. 如果知识库中有相关信息，请直接引用并说明来源
3. 如果知识库中没有相关信息，可以使用你的通用知识回答，但请说明这不是来自知识库`,
        },
        ...messages.slice(0, -1), // 保留历史消息
      ]
    : messages;

  // 3. 调用 LLM API
  const stream = await client.messages.create({
    model: 'deepseek-v4-pro',
    messages: enhancedMessages,
    stream: true,
    max_tokens: 4096,
  });

  // 4. 返回流式响应
  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta') {
            controller.enqueue(
              new TextEncoder().encode(chunk.delta.text)
            );
          }
        }
        controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    }
  );
}
```

## 六、完整流程

### 6.1 知识同步流程

```
┌─────────────┐
│ Notion 页面 │
└──────┬──────┘
       │
       ↓ NotionClient.getPage()
┌─────────────┐
│  页面内容   │ (纯文本)
└──────┬──────┘
       │
       ↓ chunkText()
┌─────────────┐
│  文本分块   │ (500字/块, 50字重叠)
└──────┬──────┘
       │
       ↓ EmbeddingClient.embedBatch()
┌─────────────┐
│  向量数组   │ (1024维 × N块)
└──────┬──────┘
       │
       ↓ Supabase.insert()
┌─────────────┐
│  数据库存储 │ (notion_pages + documents)
└─────────────┘
```

### 6.2 问答检索流程

```
┌─────────────┐
│  用户提问   │ "什么是向量模型？"
└──────┬──────┘
       │
       ↓ EmbeddingClient.embedSingle()
┌─────────────┐
│  问题向量   │ (1024维)
└──────┬──────┘
       │
       ↓ match_documents() RPC
┌─────────────┐
│ 向量相似度  │ 余弦相似度 > 0.5
│   搜索      │
└──────┬──────┘
       │
       ↓ 返回 Top-K 文档
┌─────────────┐
│  相关文档   │ (3个最相似的块)
└──────┬──────┘
       │
       ↓ formatContext()
┌─────────────┐
│ RAG 上下文  │ [文档1] 内容...\n[文档2] 内容...
└──────┬──────┘
       │
       ↓ 注入到用户消息
┌─────────────┐
│ 增强消息    │ "知识库参考资料:\n...\n用户问题:..."
└──────┬──────┘
       │
       ↓ LLM API
┌─────────────┐
│  生成回答   │ 基于知识库内容回答
└─────────────┘
```

## 七、关键问题与解决方案

### 7.1 文本分块死循环
**问题**：chunking.ts 在处理某些文本时 CPU 占用 98%，进程卡死

**原因**：
```typescript
// 错误代码
if (startChar <= chunks[chunks.length - 1]?.startChar) {
  startChar = endChar;
}
```
当 `overlap` 很大时，`nextStart` 可能小于当前 `startChar`，但条件判断错误导致无限循环。

**解决**：
```typescript
// 正确代码
const nextStart = endChar - overlap;
if (nextStart <= startChar) {
  startChar = endChar; // 防止死循环
} else {
  startChar = nextStart;
}
```

### 7.2 数据库列不存在错误
**问题**：`column page_id of relation documents does not exist`

**原因**：旧的数据库 schema 使用了 `page_id` 字段，新代码使用 `notion_page_id` 外键

**解决**：创建 `database-schema-clean.sql`，先删除旧表再创建新表
```sql
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS notion_pages CASCADE;
-- 然后创建新表结构
```

### 7.3 WebSocket 错误
**问题**：`Node.js 20 detected without native WebSocket support`

**原因**：Supabase 客户端需要 WebSocket 支持，但 Node.js 20 默认未启用

**解决**：
```bash
npm install ws @types/ws
```

```typescript
import ws from 'ws';

const supabase = createClient(url, key, {
  global: {
    fetch: fetch,
    WebSocket: ws as any,
  },
});
```

### 7.4 RAG 注入验证
**问题**：用户在浏览器 Network 面板看到请求体中没有 RAG 上下文

**原因**：RAG 注入是在**服务端**完成的，浏览器发送的是原始问题

**验证方法**：
1. 在服务端添加日志：
```typescript
console.log('[RAG] 发送给 LLM 的完整消息:', JSON.stringify(enhancedMessages[0], null, 2));
```

2. 观察 LLM 回答是否引用了知识库内容（如 `[文档 1]`、`[文档 2]`）

## 八、性能优化

### 8.1 向量索引
使用 HNSW (Hierarchical Navigable Small World) 索引：
```sql
CREATE INDEX documents_embedding_idx ON documents 
USING hnsw (embedding vector_cosine_ops);
```
- **查询速度**：O(log N) vs 全表扫描 O(N)
- **适用场景**：百万级向量数据

### 8.2 批量向量化
```typescript
// ❌ 慢：逐个调用 API
for (const chunk of chunks) {
  const embedding = await embedSingle(chunk.text);
}

// ✅ 快：批量调用
const embeddings = await embedBatch(chunks.map(c => c.text));
```

### 8.3 增量同步
```typescript
// 检查页面是否更新
const { data: existingPage } = await supabase
  .from('notion_pages')
  .select('last_edited_time')
  .eq('page_id', pageId)
  .single();

if (existingPage && existingPage.last_edited_time === page.lastEditedTime) {
  return { success: true, message: '页面未更新，跳过同步' };
}
```

## 九、使用指南

### 9.1 环境变量配置
```env
# Notion API
NOTION_API_KEY=secret_xxx

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx

# Anthropic API (向量模型)
ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com

# LLM API (DeepSeek)
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

### 9.2 同步 Notion 页面
```bash
# 单页面同步
npx tsx lib/server/test-sync.ts <notion_page_id>

# 示例
npx tsx lib/server/test-sync.ts 35d7288dd13f80c7b2d8c051dffd706a
```

### 9.3 测试检索
```bash
npx tsx lib/server/test-retriever.ts "什么是向量模型？"
```

### 9.4 启动应用
```bash
npm run dev
```
访问 http://localhost:3000，开始提问！

## 十、后续优化方向

### 10.1 引用来源显示（M1.8）
在前端显示回答的来源文档链接：
```typescript
// 返回格式
{
  answer: "...",
  sources: [
    { title: "向量模型介绍", url: "https://notion.so/xxx", similarity: 0.85 }
  ]
}
```

### 10.2 批量同步
```typescript
// 同步整个 Notion 数据库
async function syncNotionDatabase(databaseId: string) {
  const pages = await notion.databases.query({ database_id: databaseId });
  for (const page of pages.results) {
    await syncNotionPage(page.id);
  }
}
```

### 10.3 定时增量同步
使用 cron job 定期检查 Notion 更新：
```typescript
// 每小时检查一次
cron.schedule('0 * * * *', async () => {
  const pages = await supabase.from('notion_pages').select('page_id');
  for (const page of pages) {
    await syncNotionPage(page.page_id);
  }
});
```

### 10.4 混合检索
结合关键词搜索和向量搜索：
```sql
-- 全文搜索 + 向量搜索
SELECT * FROM documents
WHERE to_tsvector('chinese', content) @@ to_tsquery('chinese', '向量模型')
ORDER BY embedding <=> query_embedding
LIMIT 5;
```

### 10.5 重排序 (Reranking)
使用专门的重排序模型提高检索精度：
```typescript
// 1. 向量搜索召回 Top-20
const candidates = await retriever.search(query, { matchCount: 20 });

// 2. 重排序模型精排 Top-3
const reranked = await reranker.rerank(query, candidates);
```

## 十一、参考资料

- [Notion API 文档](https://developers.notion.com/)
- [Supabase pgvector 指南](https://supabase.com/docs/guides/ai/vector-columns)
- [Anthropic Embeddings API](https://docs.anthropic.com/en/docs/build-with-claude/embeddings)
- [HNSW 算法论文](https://arxiv.org/abs/1603.09320)

---

**文档版本**：v1.0  
**最后更新**：2026-05-12  
**作者**：Claude Code
