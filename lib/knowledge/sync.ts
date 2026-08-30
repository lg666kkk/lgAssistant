/**
 * Notion 同步模块
 * 整合 Notion 读取、文本切块、向量生成、数据库写入
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import ws from 'ws';
import { ragConfig } from '@/lib/platform/config';
import { createUserEmbeddingClient } from '@/lib/embedding-config/service';
import { NotionClient } from './notion';
import { resolveUserNotionConnection } from './connections/notion-config';
import type { ResolvedUserNotionConnection } from './connections/types';
import {
  CHUNKER_VERSION,
  DEFAULT_CHUNK_MAX_TOKENS,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  chunkText,
  type TextChunk,
} from './chunking';
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_MODEL,
  type EmbeddingBatchEvent,
  validateEmbeddingVector,
} from './embedding';

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const SYNC_MAX_RETRIES = 3;
const SYNC_RETRY_BASE_DELAY_MS = 800;

export type AtomicDocumentPayload = {
  chunk_index: number;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
};

export function buildParentContext(
  chunks: TextChunk[],
  index: number,
  pageId: string,
  maxChars: number = ragConfig.parentContextMaxChars,
) {
  const current = chunks[index];
  if (!current) {
    throw new Error(`Chunk index 越界: ${index}/${chunks.length}`);
  }

  const headingKey = current.headingPath.join('\u0000');
  let start = index;
  let end = index;
  let totalChars = current.text.length;
  let left = index - 1;
  let right = index + 1;

  while (left >= 0 || right < chunks.length) {
    let expanded = false;
    const leftChunk = chunks[left];
    if (
      leftChunk
      && leftChunk.headingPath.join('\u0000') === headingKey
      && totalChars + 2 + leftChunk.text.length <= maxChars
    ) {
      start = left;
      totalChars += 2 + leftChunk.text.length;
      left--;
      expanded = true;
    } else {
      left = -1;
    }

    const rightChunk = chunks[right];
    if (
      rightChunk
      && rightChunk.headingPath.join('\u0000') === headingKey
      && totalChars + 2 + rightChunk.text.length <= maxChars
    ) {
      end = right;
      totalChars += 2 + rightChunk.text.length;
      right++;
      expanded = true;
    } else {
      right = chunks.length;
    }

    if (!expanded) break;
  }

  const parentChunks = chunks.slice(start, end + 1);
  const startChar = parentChunks[0].startChar;
  const endChar = parentChunks[parentChunks.length - 1].endChar;
  return {
    content: parentChunks.map((chunk) => chunk.text).join('\n\n'),
    key: `${pageId}:${startChar}:${endChar}`,
    startChar,
    endChar,
    childCount: parentChunks.length,
  };
}

export function buildAtomicDocumentPayload(input: {
  chunks: TextChunk[];
  embeddings: number[][];
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  lastEditedTime: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingProvider?: string;
}): AtomicDocumentPayload[] {
  if (input.embeddings.length !== input.chunks.length) {
    throw new Error(
      `向量数量与 chunk 数量不一致: ${input.embeddings.length}/${input.chunks.length}`,
    );
  }

  return input.chunks.map((chunk, index) => {
    const embedding = input.embeddings[index];
    validateEmbeddingVector(embedding, `Chunk #${chunk.index}`);
    const parentContext = buildParentContext(input.chunks, index, input.pageId);

    return {
      chunk_index: chunk.index,
      content: chunk.text,
      embedding,
      metadata: {
        page_id: input.pageId,
        page_title: input.pageTitle,
        page_url: input.pageUrl,
        chunk_index: chunk.index,
        start_char: chunk.startChar,
        end_char: chunk.endChar,
        heading_path: chunk.headingPath,
        chunk_kind: chunk.kind ?? 'text',
        chunk_token_count: chunk.tokenCount,
        parent_content: parentContext.content,
        parent_key: parentContext.key,
        parent_start_char: parentContext.startChar,
        parent_end_char: parentContext.endChar,
        parent_child_count: parentContext.childCount,
        content_hash: hashText(chunk.text),
        source_type: 'notion',
        embedding_model: input.embeddingModel ?? EMBEDDING_MODEL,
        embedding_dimensions: input.embeddingDimensions ?? EMBEDDING_DIMENSIONS,
        embedding_provider: input.embeddingProvider ?? 'dashscope',
        chunker_version: CHUNKER_VERSION,
        last_edited_time: input.lastEditedTime,
      },
    };
  });
}

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
  indexVersion?: string;
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
    | 'embedding_batch_start'
    | 'embedding_batch_retry'
    | 'embedding_batch_done'
    | 'embedding_batch_failed'
    | 'page_embedded'
    | 'db_page_upserted'
    | 'db_old_chunks_deleted'
    | 'db_chunks_inserted'
    | 'db_atomic_replace_start'
    | 'db_atomic_replace_committed'
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
  userId: string;
  force?: boolean;
  maxRetries?: number;
  onEvent?: (event: SyncProgressEvent) => void;
  notionConnection?: ResolvedUserNotionConnection;
};

async function withNotionConnection(options: SyncOptions): Promise<SyncOptions> {
  if (options.notionConnection) return options;
  return {
    ...options,
    notionConnection: await resolveUserNotionConnection(options.userId),
  };
}

function emitSyncEvent(options: SyncOptions | undefined, event: SyncProgressEvent) {
  options?.onEvent?.(event);
}

function emitEmbeddingBatchEvent(
  options: SyncOptions,
  page: { id: string; title: string },
  event: EmbeddingBatchEvent,
) {
  const { type: batchEventType, ...metadata } = event;
  const type = `embedding_${batchEventType}` as SyncProgressEvent['type'];
  let message = `Embedding 批次 ${event.batchIndex}/${event.totalBatches}`;

  if (batchEventType === 'batch_start') {
    message += ` 开始：${event.inputCount} 条输入`;
  } else if (batchEventType === 'batch_retry') {
    message += ` 失败，${event.nextDelayMs}ms 后重试 ${event.attempt + 1}/${event.maxAttempts}`;
  } else if (batchEventType === 'batch_done') {
    message += event.reordered ? ' 完成，已按 provider index 重排' : ' 完成';
  } else {
    message += ` 最终失败：${event.error}`;
  }

  emitSyncEvent(options, {
    type,
    pageId: page.id,
    pageTitle: page.title,
    chunksCount: event.inputCount,
    status: batchEventType === 'batch_failed' ? 'failed' : undefined,
    message,
    metadata,
  });
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
  embeddingModel = EMBEDDING_MODEL,
): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const value = metadata as Record<string, unknown>;
  return (
    value.content_hash === contentHash &&
    value.embedding_model === embeddingModel &&
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
  options: SyncOptions,
): Promise<SyncResult> {
  const resolvedOptions = await withNotionConnection(options);
  const maxRetries = Math.min(Math.max(resolvedOptions.maxRetries ?? SYNC_MAX_RETRIES, 0), 8);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await syncNotionPageOnce(pageId, resolvedOptions, attempt + 1, maxRetries);
    if (result.success || attempt >= maxRetries) {
      return result;
    }

    const nextDelayMs = SYNC_RETRY_BASE_DELAY_MS * 2 ** attempt;
    emitSyncEvent(resolvedOptions, {
      type: 'page_retry',
      pageId,
      status: 'failed',
      message: `同步失败，准备重试 ${attempt + 1}/${maxRetries}：${result.error}`,
      metadata: {
        attempt: attempt + 1,
        maxRetries,
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
  options: SyncOptions,
  attempt = 1,
  maxRetries = SYNC_MAX_RETRIES,
): Promise<SyncResult> {
  emitSyncEvent(options, {
    type: 'page_start',
    pageId,
    message: `开始同步页面 ${pageId}`,
    metadata: {
      attempt,
      maxRetries,
    },
  });

  try {
    const embeddingRuntime = await createUserEmbeddingClient(options.userId);
    const embeddingModel = embeddingRuntime.config.modelId;
    // 1. 读取 Notion 页面
    const notionConnection = options.notionConnection;
    if (!notionConnection) throw new Error('Notion 连接未解析');
    const notionClient = new NotionClient({
      apiKey: notionConnection.token,
      maxBlockDepth: notionConnection.maxDepth,
    });
    const page = await notionClient.getPage(pageId);
    const pageContentHash = hashText(page.content);
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
    const existingPageQuery = supabase
      .from('notion_pages')
      .select('id, page_id, chunk_count, metadata')
      .eq('page_id', pageId)
      .eq('user_id', options.userId);

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
        embeddingModel,
        chunkerVersion: CHUNKER_VERSION,
        force: Boolean(options.force),
      },
    });

    if (!options.force && isSameIndexedVersion(
      existingPage?.metadata,
      pageContentHash,
      embeddingModel,
    )) {
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
        indexVersion: pageContentHash,
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
        maxTokens: DEFAULT_CHUNK_MAX_TOKENS,
        overlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
        chunkerVersion: CHUNKER_VERSION,
      },
    });
    const chunks = chunkText(page.content, {
      chunkSize: 700,
      overlap: 50,
      minChunkSize: 100,
    });
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
        maxTokens: DEFAULT_CHUNK_MAX_TOKENS,
        overlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
        samples: chunks.slice(0, 5).map((chunk) => ({
          index: chunk.index,
          chars: chunk.text.length,
          tokens: chunk.tokenCount,
          kind: chunk.kind,
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
          tokenCount: chunk.tokenCount,
          kind: chunk.kind,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
          headingPath: chunk.headingPath,
          preview: compactText(chunk.text, 220),
        },
      });
    }

    if (chunks.length === 0) {
      return {
        pageId,
        pageTitle: page.title,
        chunksCount: 0,
        success: true,
        status: 'skipped',
        indexVersion: pageContentHash,
      };
    }

    // 3. 生成向量
    emitSyncEvent(options, {
      type: 'embedding_start',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      message: `开始为 ${chunks.length} 个 chunk 生成向量`,
      metadata: {
        embeddingModel,
        expectedDimensions: embeddingRuntime.config.dimensions,
        batchSize: EMBEDDING_BATCH_SIZE,
        totalBatches: Math.ceil(chunks.length / EMBEDDING_BATCH_SIZE),
        maxRetriesPerBatch: EMBEDDING_MAX_RETRIES,
      },
    });
    const embeddings = await embeddingRuntime.client.embedBatch(
      chunks.map((c) => c.text),
      {
        idempotencyScope: [
          options.userId,
          pageId,
          pageContentHash,
          embeddingModel,
          CHUNKER_VERSION,
        ].join(':'),
        onEvent: (event) => emitEmbeddingBatchEvent(
          options,
          { id: pageId, title: page.title },
          event,
        ),
      },
    );
    emitSyncEvent(options, {
      type: 'page_embedded',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      message: `已生成 ${embeddings.length} 个向量`,
      metadata: {
        embeddingModel,
        vectorCount: embeddings.length,
        dimensions: embeddings[0]?.length ?? 0,
        totalBatches: Math.ceil(chunks.length / EMBEDDING_BATCH_SIZE),
        batchSize: EMBEDDING_BATCH_SIZE,
      },
    });

    // 4. 原子替换数据库索引
    const syncStatus = existingPage ? 'updated' : 'created';
    const documents = buildAtomicDocumentPayload({
      chunks,
      embeddings,
      pageId,
      pageTitle: page.title,
      pageUrl: page.url,
      lastEditedTime: page.lastEditedTime,
      embeddingModel,
      embeddingDimensions: embeddingRuntime.config.dimensions,
      embeddingProvider: embeddingRuntime.config.provider,
    });
    emitSyncEvent(options, {
      type: 'db_atomic_replace_start',
      pageId,
      pageTitle: page.title,
      chunksCount: chunks.length,
      status: syncStatus,
      message: `开始原子替换页面元数据和 ${documents.length} 个 chunk`,
      metadata: {
        rpc: 'sync_notion_page_documents_atomic',
        tables: ['notion_pages', 'documents'],
        chunkCount: documents.length,
        firstChunkHash: documents[0]?.metadata.content_hash?.toString().slice(0, 12),
      },
    });

    const { data: atomicWriteRows, error: atomicWriteError } = await supabase.rpc(
      'sync_notion_page_documents_atomic',
      {
        p_user_id: options.userId,
        p_page_id: pageId,
        p_page_title: page.title,
        p_page_url: page.url,
        p_last_edited_time: page.lastEditedTime,
        p_page_metadata: {
          content_hash: pageContentHash,
          index_version: pageContentHash,
          embedding_model: embeddingModel,
          embedding_dimensions: embeddingRuntime.config.dimensions,
          embedding_provider: embeddingRuntime.config.provider,
          chunker_version: CHUNKER_VERSION,
        },
        p_documents: documents,
      },
    );

    if (atomicWriteError) {
      throw new Error(`原子替换页面索引失败: ${atomicWriteError.message}`);
    }

    const atomicWrite = Array.isArray(atomicWriteRows)
      ? atomicWriteRows[0]
      : atomicWriteRows;
    const insertedCount = Number(atomicWrite?.inserted_count);
    if (!atomicWrite?.page_row_id || insertedCount !== documents.length) {
      throw new Error(
        `原子替换返回异常: inserted=${Number.isFinite(insertedCount) ? insertedCount : 'unknown'}, expected=${documents.length}`,
      );
    }

    emitSyncEvent(options, {
      type: 'db_atomic_replace_committed',
      pageId,
      pageTitle: page.title,
      chunksCount: insertedCount,
      status: syncStatus,
      message: `原子替换已提交：${insertedCount} 个 chunk`,
      metadata: {
        rpc: 'sync_notion_page_documents_atomic',
        pageRowId: atomicWrite.page_row_id,
        insertedCount,
        transaction: 'committed',
      },
    });

    emitSyncEvent(options, {
      type: 'page_written',
      pageId,
      pageTitle: page.title,
      chunksCount: documents.length,
      status: syncStatus,
      message: `已写入 ${documents.length} 个文档块`,
    });

    // 5. 完成
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
      indexVersion: pageContentHash,
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
  options: SyncOptions,
): Promise<SyncResult[]> {
  const resolvedOptions = await withNotionConnection(options);
  emitSyncEvent(resolvedOptions, {
    type: 'batch_start',
    totalPages: pageIds.length,
    message: `开始批量同步 ${pageIds.length} 个页面`,
  });

  const results: SyncResult[] = [];

  for (let index = 0; index < pageIds.length; index++) {
    const pageId = pageIds[index];
    emitSyncEvent(resolvedOptions, {
      type: 'page_start',
      pageId,
      totalPages: pageIds.length,
      message: `准备同步第 ${index + 1}/${pageIds.length} 个页面`,
      metadata: {
        pageIndex: index + 1,
        totalPages: pageIds.length,
      },
    });
    const result = await syncNotionPage(pageId, resolvedOptions);
    results.push(result);
  }

  // 统计结果
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const createdCount = results.filter((r) => r.status === 'created').length;
  const updatedCount = results.filter((r) => r.status === 'updated').length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunksCount, 0);

  emitSyncEvent(resolvedOptions, {
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
  options: SyncOptions,
): Promise<SyncResult[]> {
  const resolvedOptions = await withNotionConnection(options);
  const notionConnection = resolvedOptions.notionConnection!;
  emitSyncEvent(resolvedOptions, {
    type: 'tree_scan_start',
    pageId,
    message: `开始扫描页面树 ${pageId}`,
  });
  const notionClient = new NotionClient({
    apiKey: notionConnection.token,
    maxBlockDepth: notionConnection.maxDepth,
  });
  const pages = await notionClient.getPageTree(pageId, {
    maxDepth: notionConnection.maxDepth,
    onPageStart: ({ pageId: currentPageId, depth, parentPageId, hintedTitle }) => {
      emitSyncEvent(resolvedOptions, {
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
      emitSyncEvent(resolvedOptions, {
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
      emitSyncEvent(resolvedOptions, {
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
      emitSyncEvent(resolvedOptions, {
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
      emitSyncEvent(resolvedOptions, {
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

  emitSyncEvent(resolvedOptions, {
    type: 'tree_scan_done',
    pageId,
    totalPages: pages.length,
    message: `页面树扫描完成，找到 ${pages.length} 个页面`,
    metadata: {
      pages,
    },
  });

  return syncNotionPages(pageIds, resolvedOptions);
}
