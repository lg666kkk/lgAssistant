-- ============================================
-- 清理旧表并重新创建
-- ============================================

-- 1. 删除旧表（如果存在）
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS notion_pages CASCADE;

-- 2. 删除旧函数（如果存在）
DROP FUNCTION IF EXISTS match_documents;
DROP FUNCTION IF EXISTS need_sync_pages;

-- 3. 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 4. 创建 notion_pages 表（用于更新检测）
CREATE TABLE notion_pages (
  page_id TEXT PRIMARY KEY,
  page_title TEXT NOT NULL,
  page_url TEXT NOT NULL,
  last_edited_time TIMESTAMPTZ NOT NULL,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  chunk_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

-- 5. 创建 documents 表（存储 chunk 和向量）
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id TEXT NOT NULL REFERENCES notion_pages(page_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. 创建索引
-- 向量相似度索引（HNSW 算法，余弦距离）
CREATE INDEX documents_embedding_idx
ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- page_id 索引
CREATE INDEX documents_page_id_idx ON documents (page_id);

-- 唯一约束
CREATE UNIQUE INDEX documents_page_chunk_unique_idx
ON documents (page_id, chunk_index);

-- notion_pages 索引
CREATE INDEX notion_pages_last_edited_idx
ON notion_pages (last_edited_time);

-- 7. 创建向量相似度检索函数
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

-- 8. 创建检查更新函数
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
