-- ============================================
-- RAG 知识库数据库设计（优化版）
-- 针对需求：更新检测 + 问答式检索
-- ============================================

-- 1. 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 创建 notion_pages 表（用于更新检测）
CREATE TABLE IF NOT EXISTS notion_pages (
  page_id TEXT PRIMARY KEY,
  page_title TEXT NOT NULL,
  page_url TEXT NOT NULL,
  last_edited_time TIMESTAMPTZ NOT NULL,  -- Notion 的 last_edited_time
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  chunk_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

COMMENT ON TABLE notion_pages IS 'Notion 页面元数据，用于更新检测';
COMMENT ON COLUMN notion_pages.last_edited_time IS 'Notion API 返回的最后编辑时间';
COMMENT ON COLUMN notion_pages.last_synced_at IS '最后同步时间';

-- 3. 创建 documents 表（存储 chunk 和向量）
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id TEXT NOT NULL REFERENCES notion_pages(page_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE documents IS 'RAG 知识库文档 chunk 表';
COMMENT ON COLUMN documents.page_id IS 'Notion 页面 ID（外键）';
COMMENT ON COLUMN documents.chunk_index IS 'chunk 在页面中的序号（从 0 开始）';

-- 4. 创建索引
-- 向量相似度索引（HNSW 算法，余弦距离）
CREATE INDEX documents_embedding_idx
ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- page_id 索引（用于按页面删除和查询）
CREATE INDEX documents_page_id_idx ON documents (page_id);

-- 唯一约束：同一页面的同一 chunk_index 只能存在一次
CREATE UNIQUE INDEX documents_page_chunk_unique_idx
ON documents (page_id, chunk_index);

-- notion_pages 的 last_edited_time 索引（用于查找需要更新的页面）
CREATE INDEX notion_pages_last_edited_idx
ON notion_pages (last_edited_time);

-- 5. 创建向量相似度检索 RPC 函数
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  page_id TEXT,
  page_title TEXT,
  page_url TEXT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.page_id,
    p.page_title,
    p.page_url,
    d.content,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  JOIN notion_pages p ON d.page_id = p.page_id
  WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents IS '向量相似度检索函数';

-- 6. 创建检查是否需要更新的函数
CREATE OR REPLACE FUNCTION need_sync_pages()
RETURNS TABLE (
  page_id TEXT,
  page_title TEXT,
  last_edited_time TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.page_id,
    p.page_title,
    p.last_edited_time,
    p.last_synced_at
  FROM notion_pages p
  WHERE p.last_edited_time > p.last_synced_at
  ORDER BY p.last_edited_time DESC;
END;
$$;

COMMENT ON FUNCTION need_sync_pages IS '返回需要同步的页面列表';
