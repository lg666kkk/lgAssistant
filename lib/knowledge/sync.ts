/**
 * Notion 同步模块
 * 整合 Notion 读取、文本切块、向量生成、数据库写入
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import ws from 'ws';
import { NotionClient } from './notion';
import { CHUNKER_VERSION, chunkText } from './chunking';
import { EMBEDDING_MODEL, EmbeddingClient } from './embedding';

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const SYNC_MAX_RETRIES = 3;
const SYNC_RETRY_BASE_DELAY_MS = 800;

/**
 * 同步结果
 */
export interface SyncResult {
  pageId: string;
  pageTitle: string;
  chunksCount: number;
  success: boolean;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  error?: string;
}

export type SyncProgressEvent = {
  type:
    | 'tree_scan_start'
    | 'tree_page_scanning'
    | 'tree_page_found'
    | 'tree_child_found'
    | 'tree_page_retry'
    | 'tree_page_failed'
    | 'tree_scan_done'
    | 'batch_start'
    | 'page_retry'
    | 'page_start'
    | 'page_read'
    | 'page_version_checked'
    | 'chunking_start'
    | 'chunk_sample'
    | 'page_skipped'
    | 'page_chunked'
    | 'embedding_start'
    | 'page_embedded'
    | 'db_page_upserted'
    | 'db_old_chunks_deleted'
    | 'db_chunks_inserted'
    | 'page_written'
    | 'page_done'
    | 'page_failed'
    | 'batch_done';
  message: string;
  pageId?: string;
  pageTitle?: string;
  status?: SyncResult['status'];
  chunksCount?: number;
  totalPages?: number;
  metadata?: Record<string, unknown>;
};

export type SyncOptions = {
  userId?: string;
  force?: boolean;
  onEvent?: (event: SyncProgressEvent) => void;
};

function emitSyncEvent(options: SyncOptions | undefined, event: SyncProgressEvent) {
  options?.onEvent?.(event);
}

function compactText(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorToMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const value = error as Error & { code?: string; status?: number; cause?: unknown };
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      status: value.status,
      cause: value.cause instanceof Error ? value.cause.message : value.cause,
      stack: value.stack?.split('\n').slice(0, 3).join('\n'),
    };
  }

  return {
    message: String(error),
  };
}

function isSameIndexedVersion(
  metadata: unknown,
  contentHash: string,
): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const value = metadata as Record<string, unknown>;
  return (
    value.content_hash === contentHash &&
    value.embedding_model === EMBEDDING_MODEL &&
    value.chunker_version === CHUNKER_VERSION
  );
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
export async function syncNotionPage(
  pageId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  for (let attempt = 0; attempt <= SYNC_MAX_RETRIES; attempt++) {
    const result = await syncNotionPageOnce(pageId, options, attempt + 1);
    if (result.success || attempt >= SYNC_MAX_RETRIES) {
      return result;
    }

    const nextDelayMs = SYNC_RETRY_BASE_DELAY_MS * 2 ** attempt;
    emitSyncEvent(options, {
      type: 'page_retry',
      pageId,
      status: 'failed',
      message: `同步失败，准备重试 ${attempt + 1}/${SYNC_MAX_RETRIES}：${result.error}`,
      metadata: {
        attempt: attempt + 1,
        maxRetries: SYNC_MAX_RETRIES,
        nextDelayMs,
        error: result.error,
      },
    });
    await sleep(nextDelayMs);
  }

  return {
    pageId,
    pageTitle: '',
    chunksCount: 0,
    success: false,
    status: 'failed',
    error: '同步失败',
  };
}

async function syncNotionPageOnce(
  pageId: string,
  options: SyncOptions = {},
  attempt = 1,
): Promise<SyncResult> {
  console.log(`\n开始同步页面: ${pageId}`);
  emitSyncEvent(options, {
    type: 'page_start',
    pageId,
    message: `开始同步页面 ${pageId}`,
    metadata: {
      attempt,
      maxRetries: SYNC_MAX_RETRIES,
    },
  });

  try {
    // 1. 读取 Notion 页面
    console.log('  [1/5] 读取 Notion 页面...');
    const notionClient = new NotionClient();
    const page = await notionClient.getPage(pageId);
    const pageContentHash = hashText(page.content);
    console.log(`  ✓ 页面标题: ${page.title}`);
    console.log(`  ✓ 内容长度: ${page.content.length} 字符`);
    emitSyncEvent(options, {
      type: 'page_read',
      pageId,
      pageTitle: page.title,
      message: `已读取页面：${page.title}`,
      metadata: {
        contentLength: page.content.length,
        url: page.url,
      },
    });

    const supabase = createSupabaseClient();
    let existingPageQuery = supabase
      .from('notion_pages')
      .select('id, page_id, chunk_count, metadata')
      .eq('page_id', pageId);

    if (options.userId) {
      existingPageQuery = existingPageQuery.eq('user_id', options.userId);
    }

    const { data: existingPage, error: existingPageError } =
      await existingPageQuery.maybeSingle();

    if (existingPageError) {
      throw new Error(`读取页面元数据失败: ${existingPageError.message}`);
    }
    emitSyncEvent(options, {
      type: 'page_version_checked',
      pageId,
      pageTitle: page.title,
      message: existingPage ? '已找到历史索引版本' : '未找到历史索引版本，将创建新索引',
      metadata: {
        existingChunkCount: existingPage?.chunk_count ?? 0,
        contentHash: pageContentHash.slice(0, 12),
        embeddingModel: EMBEDDING_MODEL,
        chunkerVersion: CHUNKER_VERSION,
        force: Boolean(options.force),
      },
    });

    if (!options.force && isSameIndexedVersion(existingPage?.metadata, pageContentHash)) {
      console.log('  ✓ 内容和索引版本未变化，跳过同步');
      emitSyncEvent(options, {
        type: 'page_skipped',
        pageId,
        pageTitle: page.title,
        chunksCount: existingPage?.chunk_count ?? 0,
        status: 'skipped',
        message: `内容和索引版本未变化，跳过：${page.title}`,
      });
      return {
        pageId,
        pageTitle: page.title,
        chunksCount: existingPage?.chunk_count ?? 0,
        success: true,
        status: 'skipped',
      };
    }

    if (options.force) {
      emitSyncEvent(options, {
        type: 'page_version_checked',
        pageId,
        pageTitle: page.title,
        message: '已开启强制刷新，将重新生成 chunks 和向量',
        metadata: {
          force: true,
          reason: 'manual_refresh',
        },
      });
    }

    // 2. 切分文本
    console.log('  [2/5] 切分文本...');
    emitSyncEvent(options, {
      type: 'chunking_start',
      pageId,
      pageTitle: page.title,
      message: '开始按标题和段落结构切分文本',
      metadata: {
        contentLength: page.content.length,
        chunkSize: 700,
        overlap: 50,
        minChunkSize: 100,
        chunkerVersion: CHUNKER_VERSION,
      },
    });
    const chunks = chunkText(page.content, {
      chunkSize: 700,
      overlap: 50,
      minChunkSize: 100,
    });
    console.log(`  ✓ 切分为 ${chunks.length} 个块`);
    emitSyncEvent(options, {
      type: 'page_chunked',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      message: `已切分为 ${chunks.length} 个 chunk`,
      metadata: {
        chunkSize: 700,
        overlap: 50,
        minChunkSize: 100,
        samples: chunks.slice(0, 5).map((chunk) => ({
          index: chunk.index,
          chars: chunk.text.length,
          range: [chunk.startChar, chunk.endChar],
          headingPath: chunk.headingPath,
          preview: compactText(chunk.text),
        })),
      },
    });
    for (const chunk of chunks.slice(0, 5)) {
      emitSyncEvent(options, {
        type: 'chunk_sample',
        pageId,
        pageTitle: page.title,
        chunksCount: chunks.length,
        message: `Chunk #${chunk.index} · ${chunk.text.length} 字符`,
        metadata: {
          index: chunk.index,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          headingPath: chunk.headingPath,
          preview: compactText(chunk.text, 220),
        },
      });
    }

    if (chunks.length === 0) {
      console.log('  ⚠️  页面内容为空，跳过同步');
      return {
        pageId,
        pageTitle: page.title,
        chunksCount: 0,
        success: true,
        status: 'skipped',
      };
    }

    // 3. 生成向量
    console.log('  [3/5] 生成向量...');
    emitSyncEvent(options, {
      type: 'embedding_start',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      message: `开始为 ${chunks.length} 个 chunk 生成向量`,
      metadata: {
        embeddingModel: EMBEDDING_MODEL,
        expectedDimensions: 1024,
      },
    });
    const embeddingClient = new EmbeddingClient();
    const embeddings = await embeddingClient.embedBatch(
      chunks.map((c) => c.text)
    );
    console.log(`  ✓ 生成 ${embeddings.length} 个向量`);
    emitSyncEvent(options, {
      type: 'page_embedded',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      message: `已生成 ${embeddings.length} 个向量`,
      metadata: {
        embeddingModel: EMBEDDING_MODEL,
        vectorCount: embeddings.length,
        dimensions: embeddings[0]?.length ?? 0,
      },
    });

    // 4. 写入数据库
    console.log('  [4/5] 写入数据库...');
    const syncStatus = existingPage ? 'updated' : 'created';

    // 4.1 插入或更新页面元数据
    const { data: savedPage, error: pageError } = await supabase
      .from('notion_pages')
      .upsert(
        {
          page_id: pageId,
          user_id: options.userId,
          page_title: page.title,
          page_url: page.url,
          last_edited_time: page.lastEditedTime,
          last_synced_at: new Date().toISOString(),
          chunk_count: chunks.length,
          metadata: {
            content_hash: pageContentHash,
            embedding_model: EMBEDDING_MODEL,
            chunker_version: CHUNKER_VERSION,
          },
        },
        options.userId ? { onConflict: 'user_id,page_id' } : undefined,
      )
      .select('id')
      .single();

    if (pageError) {
      throw new Error(`插入页面元数据失败: ${pageError.message}`);
    }
    if (!savedPage?.id) {
      throw new Error('插入页面元数据失败: 未返回 notion_pages.id');
    }
    emitSyncEvent(options, {
      type: 'db_page_upserted',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      status: syncStatus,
      message: `已更新页面元数据：${syncStatus}`,
      metadata: {
        table: 'notion_pages',
        pageUrl: page.url,
        lastEditedTime: page.lastEditedTime,
      },
    });

    // 4.2 删除旧的 chunks（如果存在）
    let deleteQuery = supabase
      .from('documents')
      .delete()
      .eq('notion_page_id', savedPage.id);

    if (options.userId) {
      deleteQuery = deleteQuery.eq('user_id', options.userId);
    }

    const { error: deleteError } = await deleteQuery;

    if (deleteError) {
      throw new Error(`删除旧 chunks 失败: ${deleteError.message}`);
    }
    emitSyncEvent(options, {
      type: 'db_old_chunks_deleted',
      pageId,
      pageTitle: page.title,
      message: '已删除旧 chunks',
      metadata: {
        table: 'documents',
      },
    });

    // 4.3 插入新的 chunks
    const documents = chunks.map((chunk, i) => ({
      user_id: options.userId,
      notion_page_id: savedPage.id,
      page_id: pageId,
      chunk_index: chunk.index,
      content: chunk.text,
      embedding: embeddings[i],
      metadata: {
        page_id: pageId,
        page_title: page.title,
        page_url: page.url,
        chunk_index: chunk.index,
        start_char: chunk.startChar,
        end_char: chunk.endChar,
        heading_path: chunk.headingPath,
        content_hash: hashText(chunk.text),
        embedding_model: EMBEDDING_MODEL,
        chunker_version: CHUNKER_VERSION,
        last_edited_time: page.lastEditedTime,
      },
    }));

    const { error: insertError } = await supabase
      .from('documents')
      .insert(documents);

    if (insertError) {
      throw new Error(`插入 chunks 失败: ${insertError.message}`);
    }
    emitSyncEvent(options, {
      type: 'db_chunks_inserted',
      pageId,
      pageTitle: page.title,
      chunksCount: documents.length,
      message: `已插入 ${documents.length} 条 documents 记录`,
      metadata: {
        table: 'documents',
        firstChunkHash: documents[0]?.metadata.content_hash?.slice(0, 12),
      },
    });

    console.log(`  ✓ 写入 ${documents.length} 个文档块`);
    emitSyncEvent(options, {
      type: 'page_written',
      pageId,
      pageTitle: page.title,
      chunksCount: documents.length,
      status: syncStatus,
      message: `已写入 ${documents.length} 个文档块`,
    });

    // 5. 完成
    console.log('  [5/5] 同步完成 ✓');
    emitSyncEvent(options, {
      type: 'page_done',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      status: syncStatus,
      message: `同步完成：${page.title}`,
    });

    return {
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      success: true,
      status: syncStatus,
    };
  } catch (error: any) {
    console.error(`  ✗ 同步失败: ${error.message}`);
    emitSyncEvent(options, {
      type: 'page_failed',
      pageId,
      status: 'failed',
      message: `同步失败：${error.message}`,
      metadata: {
        error: error.message,
      },
    });
    return {
      pageId,
      pageTitle: '',
      chunksCount: 0,
      success: false,
      status: 'failed',
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
  pageIds: string[],
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  console.log(`\n=== 批量同步 ${pageIds.length} 个页面 ===`);
  emitSyncEvent(options, {
    type: 'batch_start',
    totalPages: pageIds.length,
    message: `开始批量同步 ${pageIds.length} 个页面`,
  });

  const results: SyncResult[] = [];

  for (let index = 0; index < pageIds.length; index++) {
    const pageId = pageIds[index];
    emitSyncEvent(options, {
      type: 'page_start',
      pageId,
      totalPages: pageIds.length,
      message: `准备同步第 ${index + 1}/${pageIds.length} 个页面`,
      metadata: {
        pageIndex: index + 1,
        totalPages: pageIds.length,
      },
    });
    const result = await syncNotionPage(pageId, options);
    results.push(result);
  }

  // 统计结果
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const createdCount = results.filter((r) => r.status === 'created').length;
  const updatedCount = results.filter((r) => r.status === 'updated').length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCount, 0);

  console.log(`\n=== 同步完成 ===`);
  console.log(`成功: ${successCount} 个页面`);
  console.log(`失败: ${failCount} 个页面`);
  console.log(`新增: ${createdCount} 个页面`);
  console.log(`更新: ${updatedCount} 个页面`);
  console.log(`跳过: ${skippedCount} 个页面`);
  console.log(`总计: ${totalChunks} 个文档块`);
  emitSyncEvent(options, {
    type: 'batch_done',
    totalPages: pageIds.length,
    chunksCount: totalChunks,
    message: `同步完成：成功 ${successCount}，失败 ${failCount}，跳过 ${skippedCount}`,
    metadata: {
      successCount,
      failCount,
      skippedCount,
      createdCount,
      updatedCount,
    },
  });

  return results;
}

/**
 * 同步一个 Notion 页面树：父页面 + 所有下级 child_page。
 */
export async function syncNotionPageTree(
  pageId: string,
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  emitSyncEvent(options, {
    type: 'tree_scan_start',
    pageId,
    message: `开始扫描页面树 ${pageId}`,
  });
  const notionClient = new NotionClient();
  const pages = await notionClient.getPageTree(pageId, {
    onPageStart: ({ pageId: currentPageId, depth, parentPageId, hintedTitle }) => {
      emitSyncEvent(options, {
        type: 'tree_page_scanning',
        pageId: currentPageId,
        pageTitle: hintedTitle,
        message: hintedTitle
          ? `进入子页面扫描：${hintedTitle}`
          : `正在扫描页面：${currentPageId}`,
        metadata: {
          depth,
          parentPageId,
        },
      });
    },
    onPageLoaded: (page) => {
      emitSyncEvent(options, {
        type: 'tree_page_found',
        pageId: page.id,
        pageTitle: page.title,
        message: `已读取页面节点：${page.title}`,
        metadata: {
          depth: page.depth,
          url: page.url,
          lastEditedTime: page.lastEditedTime,
        },
      });
    },
    onChildPageFound: (child) => {
      emitSyncEvent(options, {
        type: 'tree_child_found',
        pageId: child.childPageId,
        pageTitle: child.childTitle,
        message: `发现子页面：${child.childTitle}`,
        metadata: {
          parentPageId: child.parentPageId,
          childPageId: child.childPageId,
          depth: child.depth,
          relation: '父页面包含 child_page 入口，下一步会进入该子页面扫描',
        },
      });
    },
    onPageRetry: (retry) => {
      emitSyncEvent(options, {
        type: 'tree_page_retry',
        pageId: retry.pageId,
        pageTitle: retry.hintedTitle,
        message: retry.hintedTitle
          ? `扫描子页面失败，准备重试 ${retry.attempt}/${retry.maxRetries}：${retry.hintedTitle}`
          : `扫描页面失败，准备重试 ${retry.attempt}/${retry.maxRetries}：${retry.pageId}`,
        metadata: {
          parentPageId: retry.parentPageId,
          depth: retry.depth,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          nextDelayMs: retry.nextDelayMs,
          ...errorToMetadata(retry.error),
        },
      });
    },
    onPageFailed: (failure) => {
      emitSyncEvent(options, {
        type: 'tree_page_failed',
        pageId: failure.pageId,
        pageTitle: failure.hintedTitle,
        message: failure.hintedTitle
          ? `扫描子页面失败：${failure.hintedTitle}`
          : `扫描页面失败：${failure.pageId}`,
        metadata: {
          parentPageId: failure.parentPageId,
          depth: failure.depth,
          ...errorToMetadata(failure.error),
        },
      });
    },
  });
  const pageIds = pages.map((page) => page.id);

  console.log(`\n=== 找到 ${pages.length} 个页面 ===`);
  for (const page of pages) {
    console.log(`${'  '.repeat(page.depth)}- ${page.title} (${page.id})`);
  }
  emitSyncEvent(options, {
    type: 'tree_scan_done',
    pageId,
    totalPages: pages.length,
    message: `页面树扫描完成，找到 ${pages.length} 个页面`,
    metadata: {
      pages,
    },
  });

  return syncNotionPages(pageIds, options);
}
