# RAG 数据库设计方案

## 设计概述

针对你的需求优化的两表设计：
- `notion_pages` - 页面元数据表（用于更新检测）
- `documents` - chunk 和向量表（用于检索）

## 核心优势

### 1. 高效更新检测
```typescript
// 同步流程
async function syncNotion() {
  // 1. 从 Notion API 获取所有页面的 last_edited_time
  const notionPages = await notion.pages.list();
  
  // 2. 查询数据库，找出需要更新的页面
  const { data } = await supabase.rpc('need_sync_pages');
  
  // 3. 只同步有变化的页面
  for (const page of notionPages) {
    const dbPage = data.find(p => p.page_id === page.id);
    
    if (!dbPage || page.last_edited_time > dbPage.last_synced_at) {
      await syncPage(page.id); // 只同步这一页
    }
  }
}
```

### 2. 级联删除
```sql
-- 删除页面时，自动删除所有 chunk
DELETE FROM notion_pages WHERE page_id = 'xxx';
-- documents 表中的相关 chunk 会自动删除（ON DELETE CASCADE）
```

### 3. 问答式检索
```typescript
// 用户提问
const query = "我的项目用什么框架？";

// 1. 生成查询向量
const embedding = await embeddingClient.embedSingle(query);

// 2. 向量检索
const { data } = await supabase.rpc('match_documents', {
  query_embedding: embedding,
  match_threshold: 0.7,
  match_count: 5
});

// 3. 返回结果（自动 JOIN 了页面信息）
// [
//   {
//     content: "项目使用 Next.js 14...",
//     page_title: "技术栈文档",
//     page_url: "https://notion.so/...",
//     similarity: 0.85
//   }
// ]
```

## 表结构详解

### notion_pages 表
```sql
notion_pages (
  page_id TEXT PRIMARY KEY,           -- Notion 页面 ID
  page_title TEXT,                    -- 页面标题
  page_url TEXT,                      -- Notion URL
  last_edited_time TIMESTAMPTZ,       -- Notion 最后编辑时间
  last_synced_at TIMESTAMPTZ,         -- 最后同步时间
  chunk_count INTEGER,                -- chunk 数量（统计用）
  metadata JSONB                      -- 扩展字段
)
```

**用途：**
- 存储页面级元数据
- 通过对比 `last_edited_time` 和 `last_synced_at` 判断是否需要更新
- 避免重复同步未变化的页面

### documents 表
```sql
documents (
  id UUID PRIMARY KEY,
  page_id TEXT REFERENCES notion_pages(page_id) ON DELETE CASCADE,
  chunk_index INTEGER,
  content TEXT,
  embedding VECTOR(1024),
  metadata JSONB,
  created_at TIMESTAMPTZ
)
```

**用途：**
- 存储文本块和向量
- 外键关联到 notion_pages
- 级联删除（删除页面时自动删除 chunks）

## 同步流程示例

### 首次同步
```typescript
async function firstSync(pageId: string) {
  // 1. 从 Notion 读取页面
  const page = await notion.pages.retrieve({ page_id: pageId });
  const content = await getPageContent(pageId);
  
  // 2. 插入页面元数据
  await supabase.from('notion_pages').insert({
    page_id: pageId,
    page_title: page.properties.title,
    page_url: page.url,
    last_edited_time: page.last_edited_time,
    last_synced_at: new Date().toISOString()
  });
  
  // 3. 切块
  const chunks = chunkText(content, 500);
  
  // 4. 生成向量
  const embeddings = await embeddingClient.embedBatch(
    chunks.map(c => c.text)
  );
  
  // 5. 插入 chunks
  await supabase.from('documents').insert(
    chunks.map((chunk, i) => ({
      page_id: pageId,
      chunk_index: i,
      content: chunk.text,
      embedding: embeddings[i]
    }))
  );
}
```

### 增量更新
```typescript
async function incrementalSync() {
  // 1. 获取所有 Notion 页面
  const notionPages = await notion.search({
    filter: { property: 'object', value: 'page' }
  });
  
  // 2. 批量更新或插入页面元数据
  for (const page of notionPages.results) {
    const { data: existing } = await supabase
      .from('notion_pages')
      .select('last_synced_at')
      .eq('page_id', page.id)
      .single();
    
    // 3. 判断是否需要同步
    if (!existing || page.last_edited_time > existing.last_synced_at) {
      console.log(`同步页面: ${page.properties.title}`);
      
      // 删除旧 chunks（会级联删除 documents）
      await supabase.from('notion_pages').delete().eq('page_id', page.id);
      
      // 重新同步
      await firstSync(page.id);
    } else {
      console.log(`跳过未变化的页面: ${page.properties.title}`);
    }
  }
}
```

## 性能预估

### 数据量
- 1000 个 Notion 页面
- 每页平均 4 个 chunks
- 总计 4000 条 documents 记录

### 检索性能
- **HNSW 索引**：对数级查询复杂度
- **预估延迟**：< 50ms（4000 条数据）
- **召回率**：> 95%

### 索引参数说明
```sql
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```
- `m = 16`：每个节点的连接数（默认值，适合中小规模）
- `ef_construction = 64`：构建时的搜索深度（默认值）

**如果数据量增长到 10 万+，可以调整为：**
```sql
WITH (m = 32, ef_construction = 128);
```

## 与 db-architect 方案的对比

### db-architect 方案（单表）
```sql
documents (
  page_id, page_title, page_url,  -- 冗余存储
  chunk_index, content, embedding
)
```

**优点：**
- 查询简单，无需 JOIN
- 单表管理

**缺点：**
- ❌ 无法高效检测更新（需要扫描所有 chunk）
- ❌ 页面标题更新时需要更新所有 chunk
- ❌ 无法统计页面级信息

### 优化方案（两表）
```sql
notion_pages (page_id, last_edited_time, last_synced_at)
documents (page_id FK, chunk_index, content, embedding)
```

**优点：**
- ✅ 高效更新检测（只查 notion_pages 表）
- ✅ 级联删除，数据一致性好
- ✅ 页面级统计方便
- ✅ JOIN 开销很小（有索引）

**缺点：**
- 需要 JOIN（但性能影响可忽略）

## 推荐方案

**对于你的需求（需要更新检测），推荐使用两表设计。**

理由：
1. 更新检测是刚需，单表无法高效实现
2. 4000 条数据的 JOIN 开销可忽略（< 5ms）
3. 未来扩展更灵活（如添加页面级标签、分类）

## 下一步

1. 在 Supabase 执行 `docs/database-schema.sql`
2. 实现 Notion 同步模块
3. 实现文本切块模块
4. 测试检索性能
