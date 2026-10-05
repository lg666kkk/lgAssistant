/**
 * 自定义文件知识源：上传落盘、解析入库、删除、访问链接。
 * 索引中的 page_id 固定为 file:<knowledge_files.id>，复用 notion_pages/documents 和 ingestion 队列。
 */

import { createHash, randomUUID } from 'node:crypto';
import { getSupabase } from '@/lib/platform/supabase';
import { linksInSpan } from './content-cleanup';
import {
  KNOWLEDGE_FILE_MAX_BYTES,
  MIME_BY_KIND,
  detectKnowledgeFileKind,
  pageRangeForSpan,
  parseKnowledgeFile,
  type KnowledgeFileKind,
} from './file-parsers';
import { failedSyncResult, indexSourceDocument, type SyncOptions, type SyncResult } from './sync';
import { prepareVisualGeneration, visualRefsInSpan } from './visual-assets';
import { assetRef } from './visual-types';
import { knowledgeImageMime, normalizeKnowledgeImage } from './image-files';

export const KNOWLEDGE_FILE_BUCKET = 'knowledge-files';
export const KNOWLEDGE_FILE_SIGNED_URL_TTL_SECONDS = 10 * 60;
const FILE_PAGE_ID_PREFIX = 'file:';

export type KnowledgeFileRecord = {
  id: string;
  user_id: string;
  file_name: string;
  mime_type: string;
  file_kind: KnowledgeFileKind;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: string;
  updated_at: string;
  visual_enabled?: boolean;
  active_generation_id?: string | null;
};

export function filePageId(fileId: string) {
  return `${FILE_PAGE_ID_PREFIX}${fileId}`;
}

export function parseFilePageId(pageId: string): string | null {
  if (!pageId.startsWith(FILE_PAGE_ID_PREFIX)) return null;
  const fileId = pageId.slice(FILE_PAGE_ID_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(fileId) ? fileId : null;
}

export function isFilePageId(pageId: string) {
  return parseFilePageId(pageId) !== null;
}

/** 引用链接走鉴权接口再跳转签名 URL，避免把短期签名写进索引。 */
export function knowledgeFileUrl(fileId: string) {
  return `/api/knowledge/files/${fileId}`;
}

export function sanitizeFileName(fileName: string) {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(-160);
  return cleaned || 'file';
}

function storageObjectName(fileName: string, kind: KnowledgeFileKind) {
  // Storage key 只允许安全字符；原始文件名保存在 knowledge_files.file_name。
  const extension = /\.[a-z0-9]{1,10}$/i.exec(fileName)?.[0]?.toLowerCase() ?? '';
  return `source${extension || `.${kind}`}`;
}

export class KnowledgeFileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function uploadKnowledgeFile(input: {
  userId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<{ file: KnowledgeFileRecord; duplicate: boolean }> {
  if (input.bytes.byteLength === 0) throw new KnowledgeFileError('文件为空');
  if (input.bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) {
    throw new KnowledgeFileError(
      `文件超过 ${Math.round(KNOWLEDGE_FILE_MAX_BYTES / 1024 / 1024)}MB 上限`,
      413,
    );
  }

  const fileName = sanitizeFileName(input.fileName);
  let kind: KnowledgeFileKind;
  try {
    kind = detectKnowledgeFileKind(fileName, input.bytes);
    if (kind === 'image') await normalizeKnowledgeImage(input.bytes, knowledgeImageMime(fileName, input.bytes));
  } catch (error) {
    throw new KnowledgeFileError(error instanceof Error ? error.message : String(error), 415);
  }
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const supabase = getSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('knowledge_files')
    .select('*')
    .eq('user_id', input.userId)
    .eq('sha256', sha256)
    .maybeSingle();
  if (existingError) throw new Error(`查询已有文件失败: ${existingError.message}`);
  if (existing) return { file: existing as KnowledgeFileRecord, duplicate: true };

  const fileId = randomUUID();
  const storagePath = `${input.userId}/${fileId}/${storageObjectName(fileName, kind)}`;
  const mimeType = kind === 'image' ? knowledgeImageMime(fileName, input.bytes) : MIME_BY_KIND[kind];
  const { error: uploadError } = await supabase.storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .upload(storagePath, input.bytes, { contentType: mimeType, upsert: false });
  if (uploadError) throw new Error(`上传文件失败: ${uploadError.message}`);

  const { data: inserted, error: insertError } = await supabase
    .from('knowledge_files')
    .insert({
      id: fileId,
      user_id: input.userId,
      file_name: fileName,
      mime_type: mimeType,
      file_kind: kind,
      size_bytes: input.bytes.byteLength,
      sha256,
      storage_path: storagePath,
    })
    .select('*')
    .single();
  if (insertError) {
    await supabase.storage.from(KNOWLEDGE_FILE_BUCKET).remove([storagePath]);
    // 并发上传同一文件时撞唯一约束，返回先写入的那条。
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('knowledge_files')
        .select('*')
        .eq('user_id', input.userId)
        .eq('sha256', sha256)
        .maybeSingle();
      if (raced) return { file: raced as KnowledgeFileRecord, duplicate: true };
    }
    throw new Error(`保存文件元数据失败: ${insertError.message}`);
  }
  return { file: inserted as KnowledgeFileRecord, duplicate: false };
}

async function getKnowledgeFile(userId: string, fileId: string) {
  const { data, error } = await getSupabase()
    .from('knowledge_files')
    .select('*')
    .eq('user_id', userId)
    .eq('id', fileId)
    .maybeSingle();
  if (error) throw new Error(`读取文件元数据失败: ${error.message}`);
  return (data as KnowledgeFileRecord | null) ?? null;
}

export async function listKnowledgeFiles(userId: string) {
  const { data, error } = await getSupabase()
    .from('knowledge_files')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`读取文件列表失败: ${error.message}`);
  return (data ?? []) as KnowledgeFileRecord[];
}

export async function syncKnowledgeFile(
  fileId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const pageId = filePageId(fileId);
  try {
    const file = await getKnowledgeFile(options.userId, fileId);
    // 文件已被删除时任务直接结束，不进入重试。
    if (!file) {
      return { pageId, pageTitle: '', chunksCount: 0, success: true, status: 'skipped' };
    }

    const { data: blob, error } = await getSupabase().storage
      .from(KNOWLEDGE_FILE_BUCKET)
      .download(file.storage_path);
    if (error || !blob) throw new Error(`下载文件失败: ${error?.message ?? '空响应'}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const parsed = await parseKnowledgeFile({
      fileName: file.file_name,
      kind: file.file_kind,
      bytes,
      captureVisuals: file.visual_enabled === true,
    });
    options.onEvent?.({
      type: 'page_read',
      pageId,
      pageTitle: parsed.title,
      message: `已解析文件：${file.file_name}`,
      metadata: {
        contentLength: parsed.content.length,
        fileKind: file.file_kind,
        pageCount: parsed.pageOffsets?.length,
      },
    });

    const generation = file.visual_enabled ? await prepareVisualGeneration({
      userId: options.userId, fileId: file.id, sourceVersion: file.sha256,
      sourceBytes: bytes, content: parsed.content, visuals: parsed.visuals ?? [],
      expectedGeneration: file.active_generation_id ?? null, analyze: true,
    }) : undefined;
    const result = await indexSourceDocument({
      sourceType: 'document',
      pageId,
      title: parsed.title,
      url: knowledgeFileUrl(file.id),
      content: parsed.content,
      // 文件内容不可变，用上传时间作为版本时间。
      lastEditedTime: file.created_at,
      pageMetadata: {
        file_id: file.id,
        file_name: file.file_name,
        file_kind: file.file_kind,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        file_sha256: file.sha256,
        page_count: parsed.pageOffsets?.length,
        ...(parsed.ocrUsed ? { text_extraction: 'ocr', ocr_languages: 'chi_sim+eng' } : {}),
        ...(generation ? { source_version: file.sha256, visual_status: generation.status,
          visual_warnings: [...(parsed.warnings ?? []), ...generation.warnings] } : {}),
      },
      ...(generation ? {
        additionalUnits: generation.assets.map((asset) => ({
          content: `${parsed.title}\n${asset.page_number ? `PDF page ${asset.page_number}` : asset.occurrence_key}\n${asset.alt_text}\n${asset.description || 'Visual content has not been analyzed. Read the original page/image if relevant.'}`,
          metadata: { content_kind: 'visual_proxy', asset_id: asset.id, file_id: file.id,
            source_version: file.sha256, generation_id: generation.id,
            visual_refs: [assetRef(asset)], analysis_status: asset.analysis_status,
            ...(asset.page_number ? { page_start: asset.page_number, page_end: asset.page_number } : {}) },
        })),
        publication: { rpc: 'publish_knowledge_visual_generation', metadata: {
          generation_id: generation.id, expected_generation_id: generation.expectedGeneration,
          pipeline_version: generation.pipelineVersion, source_version: file.sha256,
          ...(options.ingestionLease ? { ingestion_lease: options.ingestionLease } : {}),
        } },
      } : {}),
      chunkMetadata: (chunk) => {
        const pages = pageRangeForSpan(parsed.pageOffsets, chunk.startChar, chunk.endChar);
        const links = linksInSpan(parsed.links, chunk.startChar, chunk.endChar);
        return {
          file_id: file.id,
          file_name: file.file_name,
          file_kind: file.file_kind,
          ...(pages ? { page_start: pages.pageStart, page_end: pages.pageEnd } : {}),
          ...(links.length ? { links } : {}),
          ...(generation ? { source_version: file.sha256, generation_id: generation.id,
            visual_refs: visualRefsInSpan(generation.assets, chunk.startChar, chunk.endChar, pages?.pageStart, pages?.pageEnd) } : {}),
        };
      },
    }, generation ? { ...options, force: true } : options);

    // 发布 RPC 与删除 RPC 共用事务锁，文件不存在时禁止发布。
    return result;
  } catch (error) {
    // 下载、解析或发布期间被删除的文件不再重试。
    try {
      if (!(await getKnowledgeFile(options.userId, fileId))) {
        return { pageId, pageTitle: '', chunksCount: 0, success: true, status: 'skipped' };
      }
    } catch {
      // 元数据查询失败不能当成文件已删除，保留原错误交由队列重试。
    }
    return failedSyncResult(pageId, options, error);
  }
}

/**
 * 原子删除元数据、索引及取消未完成任务，返回待清理的 Storage 路径。
 */
async function deleteKnowledgeFileRecord(userId: string, fileId: string): Promise<string | null> {
  const { data, error } = await getSupabase().rpc('delete_knowledge_file_atomic', {
    p_user_id: userId,
    p_file_id: fileId,
  });
  if (error) throw new Error(`删除文件失败: ${error.message}`);
  return data ?? null;
}

export async function deleteKnowledgeFile(userId: string, fileId: string) {
  const storagePath = await deleteKnowledgeFileRecord(userId, fileId);
  if (!storagePath) return false;
  const { error: storageError } = await getSupabase().storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .remove([storagePath]);
  if (storageError) {
    console.warn(`[knowledge-files] Storage 对象删除失败 ${storagePath}: ${storageError.message}`);
  }
  return true;
}

export async function readKnowledgeTextFile(userId: string, fileId: string) {
  const file = await getKnowledgeFile(userId, fileId);
  if (!file || !['markdown', 'text', 'html'].includes(file.file_kind)) return null;
  const { data, error } = await getSupabase().storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .download(file.storage_path);
  if (error || !data) throw new Error(`读取文件失败: ${error?.message ?? '空响应'}`);
  return { fileName: file.file_name, bytes: new Uint8Array(await data.arrayBuffer()) };
}

export async function createKnowledgeFileSignedUrl(userId: string, fileId: string) {
  const file = await getKnowledgeFile(userId, fileId);
  if (!file) return null;
  const { data, error } = await getSupabase().storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .createSignedUrl(file.storage_path, KNOWLEDGE_FILE_SIGNED_URL_TTL_SECONDS, {
      download: file.file_kind === 'docx' ? file.file_name : undefined,
    });
  if (error || !data?.signedUrl) throw new Error(`生成访问链接失败: ${error?.message ?? '空响应'}`);
  return data.signedUrl as string;
}

/**
 * 清空知识库时连带清理文件；返回删除的文件数。
 */
export async function deleteAllKnowledgeFiles(userId: string) {
  const files = await listKnowledgeFiles(userId);
  if (files.length === 0) return 0;
  const supabase = getSupabase();
  const paths: string[] = [];
  try {
    for (const file of files) {
      const path = await deleteKnowledgeFileRecord(userId, file.id);
      if (path) paths.push(path);
    }
  } finally {
    // 后续某个事务失败时，仍清理已经成功删除的文件对象。
    for (let index = 0; index < paths.length; index += 100) {
      const { error: storageError } = await supabase.storage
        .from(KNOWLEDGE_FILE_BUCKET)
        .remove(paths.slice(index, index + 100));
      if (storageError) console.warn(`[knowledge-files] 批量删除 Storage 对象失败: ${storageError.message}`);
    }
  }
  return paths.length;
}
