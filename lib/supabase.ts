import { createClient } from '@supabase/supabase-js';

// 初始化 Supabase 客户端
// SUPABASE_URL: 项目地址（如 https://xxx.supabase.co）
// SUPABASE_SERVICE_ROLE_KEY: 服务端密钥，拥有最高权限，只能在后端使用
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 文档 chunk 的类型定义
export interface DocumentChunk {
  content: string;
  metadata: {
    page_id: string;
    page_title: string;
    chunk_index: number;
    last_edited: string;
  };
  embedding: number[];
}

// 搜索结果的类型定义
export interface SearchResult {
  id: number;
  content: string;
  metadata: {
    page_id: string;
    page_title: string;
  };
  similarity: number;
}

// 批量插入文档 chunk 到 documents 表
// 注意：supabase 操作是异步的，必须用 async/await
export async function insertDocuments(chunks: DocumentChunk[]) {
  const { error } = await supabase
    .from('documents')
    .insert(chunks.map(chunk => ({
      content: chunk.content,
      metadata: chunk.metadata,
      embedding: chunk.embedding,
    })));

  if (error) throw new Error(`插入文档失败: ${error.message}`);
}

// 根据 page_id 删除旧数据
// 重新同步某个 Notion 页面前，先删掉它之前的所有 chunk
// metadata->>page_id 是 PostgreSQL 提取 JSON 字段的语法
export async function deleteDocumentsByPageId(pageId: string) {
  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('metadata->>page_id', pageId);

  if (error) throw new Error(`删除文档失败: ${error.message}`);
}

// 向量相似搜索
// 调用 SQL 中创建的 match_documents 函数，返回最相似的文档
export async function searchDocuments(
  queryEmbedding: number[],
  threshold = 0.7,
  count = 5
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: count,
  });

  if (error) throw new Error(`搜索文档失败: ${error.message}`);
  return data || [];
}
