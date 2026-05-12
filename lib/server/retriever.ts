/**
 * RAG 检索模块
 * 用于从向量数据库中检索相关文档
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { EmbeddingClient } from './embedding';

/**
 * 检索结果
 */
export interface SearchResult {
  id: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  content: string;
  similarity: number;
}

/**
 * 创建 Supabase 客户端
 */
function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('缺少 Supabase 环境变量');
  }

  return createClient(supabaseUrl, supabaseKey, {
    realtime: {
      transport: ws as any,
    },
  });
}

/**
 * RAG 检索类
 */
export class RAGRetriever {
  private embeddingClient: EmbeddingClient;
  private supabase: ReturnType<typeof createSupabaseClient>;

  constructor() {
    this.embeddingClient = new EmbeddingClient();
    this.supabase = createSupabaseClient();
  }

  /**
   * 检索相关文档
   * @param query 用户问题
   * @param options 检索选项
   * @returns 相关文档列表
   */
  async search(
    query: string,
    options: {
      matchThreshold?: number;  // 相似度阈值（0-1）
      matchCount?: number;       // 返回数量
    } = {}
  ): Promise<SearchResult[]> {
    const {
      matchThreshold = 0.7,
      matchCount = 5,
    } = options;

    // 1. 生成查询向量
    const queryEmbedding = await this.embeddingClient.embedSingle(query);

    // 2. 调用数据库检索函数
    const { data, error } = await this.supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) {
      throw new Error(`检索失败: ${error.message}`);
    }

    // 3. 转换结果格式
    return (data || []).map((item: any) => ({
      id: item.id,
      pageId: item.page_id,
      pageTitle: item.page_title,
      pageUrl: item.page_url,
      content: item.content,
      similarity: item.similarity,
    }));
  }

  /**
   * 格式化检索结果为上下文文本
   * @param results 检索结果
   * @returns 格式化的上下文文本
   */
  formatContext(results: SearchResult[]): string {
    if (results.length === 0) {
      return '';
    }

    const contextParts = results.map((result, index) => {
      return `[文档 ${index + 1}] ${result.pageTitle}\n${result.content}`;
    });

    return contextParts.join('\n\n---\n\n');
  }

  /**
   * 格式化引用信息
   * @param results 检索结果
   * @returns 引用信息数组
   */
  formatReferences(results: SearchResult[]) {
    return results.map((result, index) => ({
      index: index + 1,
      title: result.pageTitle,
      url: result.pageUrl,
      similarity: Math.round(result.similarity * 100),
    }));
  }
}
