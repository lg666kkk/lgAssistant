/**
 * Notion 同步模块
 * 整合 Notion 读取、文本切块、向量生成、数据库写入
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { NotionClient } from './notion';
import { chunkText } from './chunking';
import { EmbeddingClient } from './embedding';

/**
 * 同步结果
 */
export interface SyncResult {
  pageId: string;
  pageTitle: string;
  chunksCount: number;
  success: boolean;
  error?: string;
}

/**
 * 创建 Supabase 客户端
 */
function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('缺少 Supabase 环境变量');
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    realtime: {
      transport: ws as any,
    },
  });
}

/**
 * 同步单个 Notion 页面到数据库
 * @param pageId Notion 页面 ID
 * @returns 同步结果
 */
export async function syncNotionPage(pageId: string): Promise<SyncResult> {
  console.log(`\n开始同步页面: ${pageId}`);

  try {
    // 1. 读取 Notion 页面
    console.log('  [1/5] 读取 Notion 页面...');
    const notionClient = new NotionClient();
    const page = await notionClient.getPage(pageId);
    console.log(`  ✓ 页面标题: ${page.title}`);
    console.log(`  ✓ 内容长度: ${page.content.length} 字符`);

    // 2. 切分文本
    console.log('  [2/5] 切分文本...');
    const chunks = chunkText(page.content, {
      chunkSize: 500,
      overlap: 50,
      minChunkSize: 100,
    });
    console.log(`  ✓ 切分为 ${chunks.length} 个块`);

    if (chunks.length === 0) {
      console.log('  ⚠️  页面内容为空，跳过同步');
      return {
        pageId,
        pageTitle: page.title,
        chunksCount: 0,
        success: true,
      };
    }

    // 3. 生成向量
    console.log('  [3/5] 生成向量...');
    const embeddingClient = new EmbeddingClient();
    const embeddings = await embeddingClient.embedBatch(
      chunks.map((c) => c.text)
    );
    console.log(`  ✓ 生成 ${embeddings.length} 个向量`);

    // 4. 写入数据库
    console.log('  [4/5] 写入数据库...');
    const supabase = createSupabaseClient();

    // 4.1 插入或更新页面元数据
    const { error: pageError } = await supabase
      .from('notion_pages')
      .upsert({
        page_id: pageId,
        page_title: page.title,
        page_url: page.url,
        last_edited_time: page.lastEditedTime,
        last_synced_at: new Date().toISOString(),
        chunk_count: chunks.length,
      });

    if (pageError) {
      throw new Error(`插入页面元数据失败: ${pageError.message}`);
    }

    // 4.2 删除旧的 chunks（如果存在）
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('page_id', pageId);

    if (deleteError) {
      throw new Error(`删除旧 chunks 失败: ${deleteError.message}`);
    }

    // 4.3 插入新的 chunks
    const documents = chunks.map((chunk, i) => ({
      page_id: pageId,
      chunk_index: chunk.index,
      content: chunk.text,
      embedding: embeddings[i],
      metadata: {
        start_char: chunk.startChar,
        end_char: chunk.endChar,
      },
    }));

    const { error: insertError } = await supabase
      .from('documents')
      .insert(documents);

    if (insertError) {
      throw new Error(`插入 chunks 失败: ${insertError.message}`);
    }

    console.log(`  ✓ 写入 ${documents.length} 个文档块`);

    // 5. 完成
    console.log('  [5/5] 同步完成 ✓');

    return {
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      success: true,
    };
  } catch (error: any) {
    console.error(`  ✗ 同步失败: ${error.message}`);
    return {
      pageId,
      pageTitle: '',
      chunksCount: 0,
      success: false,
      error: error.message,
    };
  }
}

/**
 * 批量同步多个 Notion 页面
 * @param pageIds Notion 页面 ID 数组
 * @returns 同步结果数组
 */
export async function syncNotionPages(
  pageIds: string[]
): Promise<SyncResult[]> {
  console.log(`\n=== 批量同步 ${pageIds.length} 个页面 ===`);

  const results: SyncResult[] = [];

  for (const pageId of pageIds) {
    const result = await syncNotionPage(pageId);
    results.push(result);
  }

  // 统计结果
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCount, 0);

  console.log(`\n=== 同步完成 ===`);
  console.log(`成功: ${successCount} 个页面`);
  console.log(`失败: ${failCount} 个页面`);
  console.log(`总计: ${totalChunks} 个文档块`);

  return results;
}
