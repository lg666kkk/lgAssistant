import { requireUser } from "@/lib/auth/server";
import { KNOWLEDGE_FILE_MAX_BYTES } from "@/lib/knowledge/file-parsers";
import {
  KnowledgeFileError,
  filePageId,
  listKnowledgeFiles,
  uploadKnowledgeFile,
} from "@/lib/knowledge/files";
import { enqueueRagIngestionJob } from "@/lib/knowledge/ingestion-queue";
import { getSupabase } from "@/lib/platform/supabase";
import { KnowledgeUploadSizeError, readKnowledgeUploadForm } from "@/lib/knowledge/upload-body";
import type { VisualProgress } from "@/lib/knowledge/visual-progress";

export const runtime = "nodejs";

type FileIndexRow = {
  page_id: string;
  page_title: string;
  chunk_count: number;
  last_synced_at: string;
  metadata?: { visual_status?: string; visual_warnings?: string[] };
};

type FileJobRow = {
  page_id: string;
  status: string;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

type VisualGenerationRow = {
  file_id: string;
  status: string;
  visual_status: string;
  created_at: string;
  progress: VisualProgress | null;
  warnings: string[];
};

/**
 * 文件列表，附带索引状态（notion_pages）和最近一次入库任务状态。
 */
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const files = await listKnowledgeFiles(user.id);
    const pageIds = files.map((file) => filePageId(file.id));
    if (pageIds.length === 0) return Response.json({ files: [] });
    const supabase = getSupabase();
    const [pagesResult, jobsResult, generationsResult] = await Promise.all([
      supabase
        .from("notion_pages")
        .select("page_id, page_title, chunk_count, last_synced_at, metadata")
        .eq("user_id", user.id)
        .in("page_id", pageIds),
      supabase
        .from("rag_ingestion_jobs")
        .select("page_id, status, last_error, attempts, created_at, updated_at")
        .eq("user_id", user.id)
        .in("page_id", pageIds)
        .order("created_at", { ascending: false }),
      supabase.from("knowledge_file_generations")
        .select("file_id, status, visual_status, created_at, progress, warnings")
        .eq("user_id", user.id)
        .in("file_id", files.map((file) => file.id))
        .order("created_at", { ascending: false }),
    ]);
    if (pagesResult.error) throw new Error(pagesResult.error.message);
    if (jobsResult.error) throw new Error(jobsResult.error.message);
    if (generationsResult.error) throw new Error(generationsResult.error.message);

    const pageById = new Map<string, FileIndexRow>(
      ((pagesResult.data ?? []) as FileIndexRow[]).map((page) => [page.page_id, page]),
    );
    const latestJobById = new Map<string, FileJobRow>();
    for (const job of (jobsResult.data ?? []) as FileJobRow[]) {
      if (!latestJobById.has(job.page_id)) latestJobById.set(job.page_id, job);
    }
    const latestGenerationById = new Map<string, VisualGenerationRow>();
    for (const generation of (generationsResult.data ?? []) as VisualGenerationRow[]) {
      if (!latestGenerationById.has(generation.file_id)) latestGenerationById.set(generation.file_id, generation);
    }

    return Response.json({
      files: files.map((file) => {
        const pageId = filePageId(file.id);
        const job = latestJobById.get(pageId);
        const generation = latestGenerationById.get(file.id);
        // A new queued/retried job must not display an earlier attempt's progress.
        const currentGeneration = generation && (!job || job.status === 'completed'
          || new Date(generation.created_at).getTime() >= new Date(job.updated_at).getTime()) ? generation : null;
        return {
          id: file.id,
          fileName: file.file_name,
          fileKind: file.file_kind,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          createdAt: file.created_at,
          visualEnabled: file.visual_enabled === true,
          pageId,
          index: pageById.get(pageId) ?? null,
          job: job ?? null,
          visualGeneration: currentGeneration,
        };
      }),
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "读取文件列表失败",
    }, { status: 500 });
  }
}

/**
 * 上传文件（multipart/form-data，字段名 file），落盘后异步入库，返回 202。
 */
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let file: File;
  try {
    const form = await readKnowledgeUploadForm(req);
    const value = form.get("file");
    if (!(value instanceof File)) {
      return Response.json({ error: "缺少 file 字段" }, { status: 400 });
    }
    file = value;
    if (file.size > KNOWLEDGE_FILE_MAX_BYTES) {
      return Response.json({ error: "文件超过 20MB 上限" }, { status: 413 });
    }
  } catch (error) {
    if (error instanceof KnowledgeUploadSizeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    // 保留 multipart 解析器的具体原因（例如代理截断请求或无效 boundary），
    // 否则前端只能显示笼统的“上传失败”，无法区分客户端和服务端问题。
    const message = error instanceof Error ? error.message : "请求体需要 multipart/form-data";
    console.error("[knowledge-files] multipart 解析失败:", error);
    return Response.json({ error: `无法解析上传请求：${message}` }, { status: 400 });
  }

  try {
    const { file: record, duplicate } = await uploadKnowledgeFile({
      userId: user.id,
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    const job = await enqueueRagIngestionJob({
      userId: user.id,
      pageId: filePageId(record.id),
      tree: false,
    });
    return Response.json({
      file: {
        id: record.id,
        fileName: record.file_name,
        fileKind: record.file_kind,
        sizeBytes: record.size_bytes,
        createdAt: record.created_at,
      },
      duplicate,
      job,
    }, { status: 202 });
  } catch (error) {
    const status = error instanceof KnowledgeFileError ? error.status : 500;
    console.error("[knowledge-files] 文件上传失败:", error);
    return Response.json({
      error: error instanceof Error ? error.message : "上传文件失败",
    }, { status });
  }
}
