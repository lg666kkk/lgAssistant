# RAG 系统优化路线图

## 当前状态（v1.0）

✅ **已完成功能**
- Notion 内容同步到向量数据库
- 基于向量相似度的语义检索
- RAG 上下文注入到 LLM
- 流式对话响应
- 增量更新检测（基于 last_edited_time）

## 短期优化（1-2 周）

### 1. 引用来源显示 ⭐⭐⭐
**优先级**：高  
**工作量**：2-3 小时

**目标**：在回答下方显示引用的知识库文档链接

**实现方案**：
```typescript
// 修改 API 返回格式
{
  answer: "向量模型是...",
  sources: [
    {
      title: "向量模型介绍",
      notionUrl: "https://notion.so/35d7288dd13f80c7b2d8c051dffd706a",
      similarity: 0.85,
      excerpt: "向量模型主要解决了..."
    }
  ]
}
```

**前端展示**：
```tsx
<div className="sources">
  <h4>📚 参考来源</h4>
  {sources.map(s => (
    <a href={s.notionUrl} target="_blank">
      {s.title} (相似度: {(s.similarity * 100).toFixed(0)}%)
    </a>
  ))}
</div>
```

**收益**：
- 用户可以追溯信息来源
- 提高回答可信度
- 方便用户深入阅读原文

---

### 2. 批量同步脚本 ⭐⭐
**优先级**：中  
**工作量**：1-2 小时

**目标**：一次性同步多个 Notion 页面

**实现方案**：
```typescript
// lib/server/batch-sync.ts
export async function syncNotionDatabase(databaseId: string) {
  const notion = new NotionClient();
  
  // 1. 查询数据库中的所有页面
  const response = await notion.client.databases.query({
    database_id: databaseId,
  });
  
  // 2. 并发同步（限制并发数为 3，避免 API 限流）
  const results = [];
  for (let i = 0; i < response.results.length; i += 3) {
    const batch = response.results.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(page => syncNotionPage(page.id))
    );
    results.push(...batchResults);
  }
  
  return results;
}
```

**使用方式**：
```bash
# 同步整个数据库
npx tsx lib/server/batch-sync.ts <database_id>

# 同步多个指定页面
npx tsx lib/server/batch-sync.ts page1_id page2_id page3_id
```

**收益**：
- 初始化知识库更方便
- 减少手动操作

---

### 3. 检索结果缓存 ⭐
**优先级**：低  
**工作量**：1 小时

**目标**：缓存常见问题的检索结果，减少向量计算

**实现方案**：
```typescript
// lib/server/retriever.ts
import NodeCache from 'node-cache';

export class RAGRetriever {
  private cache = new NodeCache({ stdTTL: 3600 }); // 1小时过期

  async search(query: string, options = {}) {
    // 1. 检查缓存
    const cacheKey = `${query}:${JSON.stringify(options)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      console.log('[RAG] 命中缓存');
      return cached;
    }

    // 2. 执行检索
    const results = await this._doSearch(query, options);

    // 3. 写入缓存
    this.cache.set(cacheKey, results);
    return results;
  }
}
```

**收益**：
- 相同问题响应更快
- 减少 API 调用成本

---

## 中期优化（1-2 个月）

### 4. 混合检索（Hybrid Search）⭐⭐⭐
**优先级**：高  
**工作量**：1 天

**目标**：结合关键词搜索和向量搜索，提高召回率

**背景**：
- **向量搜索**：擅长语义理解，但对专有名词、代码、数字不敏感
- **关键词搜索**：精确匹配，但无法理解同义词

**实现方案**：
```sql
-- 1. 添加全文搜索索引
ALTER TABLE documents ADD COLUMN content_tsv TSVECTOR;

CREATE INDEX documents_content_tsv_idx ON documents 
USING GIN (content_tsv);

-- 2. 自动更新 tsvector
CREATE TRIGGER documents_content_tsv_update 
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION
tsvector_update_trigger(content_tsv, 'pg_catalog.simple', content);

-- 3. 混合检索函数
CREATE OR REPLACE FUNCTION hybrid_search(
    query_text TEXT,
    query_embedding VECTOR(1024),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    metadata JSONB,
    vector_score FLOAT,
    keyword_score FLOAT,
    final_score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.content,
        d.metadata,
        (1 - (d.embedding <=> query_embedding)) AS vector_score,
        ts_rank(d.content_tsv, to_tsquery('simple', query_text)) AS keyword_score,
        -- 加权融合：向量 70% + 关键词 30%
        (0.7 * (1 - (d.embedding <=> query_embedding)) + 
         0.3 * ts_rank(d.content_tsv, to_tsquery('simple', query_text))) AS final_score
    FROM documents d
    WHERE 
        (1 - (d.embedding <=> query_embedding)) > match_threshold
        OR d.content_tsv @@ to_tsquery('simple', query_text)
    ORDER BY final_score DESC
    LIMIT match_count;
END;
$$;
```

**收益**：
- 专有名词检索更准确（如 "pgvector"、"HNSW"）
- 代码片段检索更精确
- 数字、日期检索更可靠

---

### 5. 重排序（Reranking）⭐⭐⭐
**优先级**：高  
**工作量**：2-3 天

**目标**：使用专门的重排序模型，提高 Top-3 结果的精度

**背景**：
- 向量搜索召回的 Top-10 中可能有噪声
- 重排序模型专门训练用于判断"问题-文档"的相关性

**实现方案**：
```typescript
// lib/server/reranker.ts
import Anthropic from '@anthropic-ai/sdk';

export class Reranker {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
  }

  async rerank(query: string, documents: any[], topK = 3) {
    // 使用 Claude 作为重排序器
    const prompt = `
给定用户问题和候选文档，为每个文档打分（0-100），表示其与问题的相关性。

用户问题：${query}

候选文档：
${documents.map((d, i) => `[${i}] ${d.content.substring(0, 200)}...`).join('\n\n')}

请返回 JSON 格式：[{"index": 0, "score": 95}, {"index": 1, "score": 80}, ...]
`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    });

    const scores = JSON.parse(response.content[0].text);
    
    // 按分数排序并返回 Top-K
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => documents[s.index]);
  }
}
```

**使用流程**：
```typescript
// 1. 向量搜索召回 Top-20
const candidates = await retriever.search(query, { matchCount: 20 });

// 2. 重排序精选 Top-3
const reranker = new Reranker();
const finalResults = await reranker.rerank(query, candidates, 3);
```

**收益**：
- 提高 Top-3 结果的准确率
- 减少无关文档干扰

---

### 6. 定时增量同步 ⭐⭐
**优先级**：中  
**工作量**：半天

**目标**：自动检测 Notion 更新并同步

**实现方案**：
```typescript
// lib/server/cron-sync.ts
import cron from 'node-cron';

// 每小时检查一次
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] 开始增量同步...');
  
  const supabase = createClient(/* ... */);
  
  // 获取所有已同步的页面
  const { data: pages } = await supabase
    .from('notion_pages')
    .select('page_id');
  
  // 逐个检查并同步
  for (const page of pages) {
    try {
      await syncNotionPage(page.page_id);
    } catch (error) {
      console.error(`[CRON] 同步失败: ${page.page_id}`, error);
    }
  }
  
  console.log('[CRON] 增量同步完成');
});
```

**部署方式**：
```bash
# 使用 PM2 保持进程运行
pm2 start lib/server/cron-sync.ts --name rag-sync
```

**收益**：
- 知识库自动保持最新
- 无需手动触发同步

---

## 长期优化（3-6 个月）

### 7. 多模态支持 ⭐⭐⭐
**优先级**：高  
**工作量**：1-2 周

**目标**：支持 Notion 中的图片、表格、代码块

**实现方案**：

#### 7.1 图片处理
```typescript
// 1. 提取图片 URL
const imageBlocks = blocks.filter(b => b.type === 'image');

// 2. 使用 Claude Vision API 生成图片描述
const imageDescription = await client.messages.create({
  model: 'claude-sonnet-4-6',
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'url', url: imageUrl } },
      { type: 'text', text: '请详细描述这张图片的内容' }
    ]
  }]
});

// 3. 将描述作为文本存储
const chunk = {
  content: `[图片] ${imageDescription}`,
  metadata: { type: 'image', url: imageUrl }
};
```

#### 7.2 表格处理
```typescript
// 将表格转换为 Markdown 格式
function tableToMarkdown(tableBlock) {
  const rows = tableBlock.table.rows;
  let markdown = '| ' + rows[0].join(' | ') + ' |\n';
  markdown += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';
  rows.slice(1).forEach(row => {
    markdown += '| ' + row.join(' | ') + ' |\n';
  });
  return markdown;
}
```

#### 7.3 代码块处理
```typescript
// 保留代码块的语言信息
function codeBlockToText(codeBlock) {
  return `\`\`\`${codeBlock.language}\n${codeBlock.code}\n\`\`\``;
}
```

**收益**：
- 支持更丰富的内容类型
- 图片内容也可以被检索

---

### 8. 对话历史记忆 ⭐⭐
**优先级**：中  
**工作量**：3-5 天

**目标**：记住用户的对话历史，支持上下文追问

**实现方案**：
```typescript
// 1. 存储对话历史
interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  ragSources?: string[]; // 使用的知识库来源
}

// 2. 构建上下文窗口（保留最近 5 轮对话）
const contextWindow = conversationHistory.slice(-5);

// 3. 注入到 LLM
const messages = [
  ...contextWindow,
  { role: 'user', content: ragEnhancedQuery }
];
```

**收益**：
- 支持"它是什么？"这类代词追问
- 更自然的对话体验

---

### 9. 知识图谱增强 ⭐⭐⭐
**优先级**：高  
**工作量**：2-3 周

**目标**：构建实体关系图谱，支持关联推荐

**实现方案**：
```typescript
// 1. 实体抽取
const entities = await extractEntities(document.content);
// 输出: ["向量模型", "RAG", "Supabase", "pgvector"]

// 2. 关系抽取
const relations = await extractRelations(document.content);
// 输出: [
//   { from: "RAG", relation: "使用", to: "向量模型" },
//   { from: "向量模型", relation: "存储在", to: "Supabase" }
// ]

// 3. 存储到图数据库（Neo4j）
await neo4j.run(`
  MERGE (a:Concept {name: $from})
  MERGE (b:Concept {name: $to})
  MERGE (a)-[:${relation}]->(b)
`, { from, to, relation });

// 4. 检索时推荐相关概念
const relatedConcepts = await neo4j.run(`
  MATCH (c:Concept {name: $query})-[r]-(related)
  RETURN related.name, type(r)
  LIMIT 5
`, { query: "向量模型" });
```

**收益**：
- 发现知识之间的关联
- 推荐相关主题
- 支持"探索式"学习

---

### 10. 多语言支持 ⭐
**优先级**：低  
**工作量**：1 周

**目标**：支持中英文混合检索

**实现方案**：
```typescript
// 1. 检测查询语言
const language = detectLanguage(query); // 'zh' | 'en'

// 2. 使用对应的分词器
const tokens = language === 'zh' 
  ? jieba.cut(query)
  : query.split(/\s+/);

// 3. 全文搜索使用对应的配置
const tsquery = language === 'zh'
  ? to_tsquery('chinese', query)
  : to_tsquery('english', query);
```

**收益**：
- 支持英文文档
- 中英文混合查询

---

## 性能优化

### 11. 向量压缩 ⭐⭐
**目标**：减少存储空间和计算成本

**方案**：
```sql
-- 使用 halfvec (512维) 代替 vector (1024维)
ALTER TABLE documents 
ALTER COLUMN embedding TYPE halfvec(512);
```

**收益**：
- 存储空间减少 50%
- 查询速度提升 30-40%
- 精度损失 < 2%

---

### 12. 分布式部署 ⭐⭐⭐
**目标**：支持大规模知识库（百万级文档）

**方案**：
```
┌─────────────┐
│  负载均衡   │
└──────┬──────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐ ┌──▼──┐
│ API │ │ API │ (多实例)
└──┬──┘ └──┬──┘
   │       │
   └───┬───┘
       │
┌──────▼──────┐
│  Supabase   │ (主从复制)
│  (Primary)  │
└─────────────┘
```

**收益**：
- 支持高并发
- 高可用性

---

## 优先级总结

### 🔥 立即实施（本周）
1. **引用来源显示** - 提升用户体验
2. **批量同步脚本** - 方便初始化

### 📅 近期实施（本月）
3. 混合检索 - 提高召回率
4. 重排序 - 提高精度
5. 定时同步 - 自动化

### 🎯 中期规划（3 个月内）
6. 多模态支持 - 支持图片、表格
7. 对话历史 - 更自然的交互
8. 知识图谱 - 关联推荐

### 🚀 长期愿景（6 个月内）
9. 多语言支持
10. 向量压缩
11. 分布式部署

---

**文档版本**：v1.0  
**最后更新**：2026-05-12  
**作者**：Claude Code
