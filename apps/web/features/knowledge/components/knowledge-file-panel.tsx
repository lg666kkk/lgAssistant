"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import { ConfirmDialog } from "@web/components/ui/feedback";
import type { VisualProgress } from "@/lib/knowledge/visual-progress";

// 与 lib/knowledge/file-parsers.ts 保持一致；不直接引用以免把 node 依赖打进客户端。
const ACCEPTED_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt", ".html", ".htm", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"];
const FORMAT_LABELS = ["PDF", "Markdown", "TXT", "HTML", "DOCX", "PNG / JPEG", "WebP / GIF", "BMP / TIFF"];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;

type KnowledgeFile = {
  id: string;
  fileName: string;
  fileKind: string;
  sizeBytes: number;
  createdAt: string;
  visualEnabled?: boolean;
  pageId: string;
  index: { chunk_count: number; last_synced_at: string; metadata?: { visual_status?: string; visual_warnings?: string[]; text_extraction?: string; ocr_languages?: string } } | null;
  job: { status: string; last_error: string | null; attempts: number } | null;
  visualGeneration?: { status: string; visual_status: string; progress: VisualProgress | null; warnings: string[] } | null;
};

type UploadItem = { key: string; fileName: string; error?: string };

type FileStatus = { label: string; tone: string; pending: boolean };

function fileStatus(file: KnowledgeFile): FileStatus {
  const jobStatus = file.job?.status;
  if (jobStatus === "queued" || jobStatus === "running" || jobStatus === "retry_wait") {
    return {
      label: jobStatus === "retry_wait" ? "等待重试" : jobStatus === "running" ? "解析中" : "排队中",
      tone: "text-amber-300",
      pending: true,
    };
  }
  if (jobStatus === "dead") return { label: "失败", tone: "text-rose-300", pending: false };
  if (file.index) return { label: `已索引 · ${file.index.chunk_count} chunks`, tone: "text-emerald-300", pending: false };
  if (jobStatus === "completed") return { label: "无内容", tone: "text-zinc-500", pending: false };
  return { label: "未入库", tone: "text-zinc-500", pending: false };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hasAcceptedExtension(fileName: string) {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function StatusBadge({ status }: { status: FileStatus }) {
  const colors = status.pending
    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
    : status.tone.includes("emerald")
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : status.tone.includes("rose")
        ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
        : "border-zinc-700 bg-zinc-900 text-zinc-400";
  return <span className={`inline-flex items-center rounded border px-1.5 py-px text-[10px] font-normal leading-4 ${colors}`}>{status.label}</span>;
}

function visualProgressLabel(file: KnowledgeFile) {
  const progress = file.visualGeneration?.progress;
  if (!progress) return "视觉：解析文件";
  if (progress.stage === "rendering") {
    return progress.currentPage && progress.total
      ? `视觉：渲染第 ${progress.currentPage}/${progress.total} 页`
      : "视觉：准备页面";
  }
  if (progress.stage === "analyzing") {
    return progress.total
      ? `视觉：模型分析 · 已处理 ${progress.processed}/${progress.total}`
      : "视觉：调用模型";
  }
  return "视觉：写入索引";
}

export function KnowledgeFilePanel({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  onChanged?: () => void;
}) {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeFile | null>(null);
  const [visualConfirmId, setVisualConfirmId] = useState<string | null>(null);
  const visualConfirmRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const pendingRef = useRef(false);

  const loadFiles = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await authFetch("/api/knowledge/files", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "加载文件列表失败");
      const next = (data.files ?? []) as KnowledgeFile[];
      const pending = next.some((file) => fileStatus(file).pending);
      // 从处理中变为完成时刷新文档列表和任务列表。
      if (pendingRef.current && !pending) onChangedRef.current?.();
      pendingRef.current = pending;
      setFiles(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载文件列表失败");
    }
  }, [enabled]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const hasPending = files.some((file) => fileStatus(file).pending);
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => void loadFiles(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasPending, loadFiles]);

  useEffect(() => {
    if (!visualConfirmId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!visualConfirmRef.current?.contains(event.target as Node)) setVisualConfirmId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVisualConfirmId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [visualConfirmId]);

  async function uploadFiles(selected: File[]) {
    if (!enabled || selected.length === 0) return;
    const items = selected.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      file,
    }));
    setUploads((current) => [...current, ...items.map(({ key, file }) => ({ key, fileName: file.name }))]);

    const failures = new Map<string, string>();
    // 顺序上传，避免同时占满带宽和内存。
    for (const { key, file } of items) {
      try {
        if (!hasAcceptedExtension(file.name)) throw new Error(`不支持的文件类型，支持 ${FORMAT_LABELS.join(" / ")}`);
        if (file.size > MAX_FILE_BYTES) throw new Error("文件超过 20MB 上限");
        const form = new FormData();
        form.append("file", file);
        const response = await authFetch("/api/knowledge/files", { method: "POST", body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "上传失败");
      } catch (error) {
        failures.set(key, error instanceof Error ? error.message : "上传失败");
      }
      setUploads((current) => current.flatMap((item) => {
        if (item.key !== key) return [item];
        const error = failures.get(key);
        return error ? [{ ...item, error }] : [];
      }));
    }
    await loadFiles();
    onChangedRef.current?.();
  }

  async function reindex(file: KnowledgeFile) {
    setBusyFileId(file.id);
    try {
      const response = await authFetch(`/api/knowledge/files/${file.id}`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "重新入库失败");
      await loadFiles();
      onChangedRef.current?.();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "重新入库失败");
    } finally {
      setBusyFileId(null);
    }
  }

  async function enableVisual(file: KnowledgeFile) {
    setBusyFileId(file.id);
    try {
      const response = await authFetch(`/api/knowledge/files/${file.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enableVisual: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '启用视觉索引失败');
      await loadFiles();
      onChangedRef.current?.();
    } catch (error) { setLoadError(error instanceof Error ? error.message : '启用视觉索引失败'); }
    finally { setBusyFileId(null); }
  }

  async function confirmDelete() {
    const file = deleteTarget;
    setDeleteTarget(null);
    if (!file) return;
    setBusyFileId(file.id);
    try {
      const response = await authFetch(`/api/knowledge/files/${file.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "删除失败");
      await loadFiles();
      onChangedRef.current?.();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyFileId(null);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">文件上传</h2>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
            {FORMAT_LABELS.map((label) => (
              <span key={label} className="rounded bg-zinc-900 px-2 py-0.5">{label}</span>
            ))}
            <span className="px-1 py-0.5">单个文件 ≤ 20MB；图片默认使用已配置的视觉模型分析，模型未配置或分析失败时回退到中英文 OCR。扫描 PDF 自动 OCR，文档视觉分析可另行开启。动图 / 多页 TIFF 仅处理首帧 / 首页。</span>
          </div>
        </div>
        <span className="text-xs text-zinc-500">{files.length} 个文件</span>
      </div>

      <div className="p-4">
        <button
          type="button"
          disabled={!enabled}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); if (enabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void uploadFiles(Array.from(event.dataTransfer.files));
          }}
          className={`flex h-28 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed text-sm transition disabled:cursor-not-allowed disabled:text-zinc-600 ${dragging ? "border-cyan-500 bg-cyan-950/20 text-cyan-200" : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"}`}
        >
          <Upload className="h-6 w-6" aria-hidden="true" />
          {enabled ? "点击选择或拖拽文件到这里" : "登录后上传文件"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            void uploadFiles(selected);
          }}
        />

        {loadError && (
          <div className="mt-3 rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">{loadError}</div>
        )}

        {(uploads.length > 0 || files.length > 0) && (
          <ul className="mt-3 divide-y divide-zinc-800 rounded-md border border-zinc-800">
            {uploads.map((item) => (
              <li key={item.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                {item.error
                  ? <FileText className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
                  : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate text-zinc-300">{item.fileName}</span>
                <span className={`max-w-xs truncate text-xs ${item.error ? "text-rose-300" : "text-cyan-300"}`}>
                  {item.error ?? "上传中"}
                </span>
                {item.error && (
                  <button
                    type="button"
                    onClick={() => setUploads((current) => current.filter((upload) => upload.key !== item.key))}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    关闭
                  </button>
                )}
              </li>
            ))}
            {files.map((file) => {
              const status = fileStatus(file);
              const busy = busyFileId === file.id;
              const metadata = file.index?.metadata;
              const isOcr = metadata?.text_extraction === "ocr";
              const visualProgress = file.visualGeneration?.progress;
              const visualRunning = file.visualEnabled && file.job?.status === "running";
              const visualStatus = file.visualGeneration?.visual_status ?? metadata?.visual_status;
              const visualLabel = file.job?.status === "queued" ? "视觉：等待处理"
                : file.job?.status === "retry_wait" ? "视觉：等待重试"
                : file.job?.status === "dead" ? "视觉：处理失败"
                : file.job?.status === "cancelled" ? "视觉：已取消"
                : visualRunning ? visualProgressLabel(file)
                : file.visualGeneration?.status === "failed" ? "视觉：处理失败"
                : visualStatus === "ready" ? "视觉：已完成"
                : visualStatus === "unconfigured" ? "视觉：需配置模型"
                : visualStatus === "partial" ? "视觉：部分完成"
                : "视觉：未执行";
              return (
                <li key={file.id} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm transition hover:bg-zinc-900/45">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <a href={`/api/knowledge/files/${file.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium text-zinc-200 hover:text-sky-300">{file.fileName}</a>
                      <span className="hidden shrink-0 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 sm:inline">{file.fileKind === 'image' ? file.fileName.split('.').pop() : file.fileKind}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-600">
                      <span>{formatSize(file.sizeBytes)}</span><span className="text-zinc-800">·</span><span>{new Date(file.createdAt).toLocaleString()}</span>
                      <StatusBadge status={status} />
                      {isOcr && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-300">OCR · 中英文</span>}
                      {file.visualEnabled && <span className={`rounded px-1.5 py-0.5 ${visualRunning ? "bg-cyan-500/10 text-cyan-300" : "bg-zinc-800 text-zinc-400"}`}>
                        {visualLabel}
                      </span>}
                      {(file.fileKind === 'pdf' || file.fileKind === 'docx' || file.fileKind === 'image') && !file.visualEnabled && (
                        <div ref={visualConfirmId === file.id ? visualConfirmRef : undefined} className="relative inline-flex">
                          <button
                            type="button"
                            disabled={busy || status.pending}
                            aria-expanded={visualConfirmId === file.id}
                            aria-controls={visualConfirmId === file.id ? `visual-confirm-${file.id}` : undefined}
                            onClick={() => setVisualConfirmId((current) => current === file.id ? null : file.id)}
                            className="rounded px-1.5 py-0.5 text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-50"
                          >
                            启用视觉索引 · 产生费用
                          </button>
                          {visualConfirmId === file.id && (
                            <div
                              id={`visual-confirm-${file.id}`}
                              role="dialog"
                              aria-label="确认启用视觉索引"
                              className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-left shadow-xl shadow-black/40"
                            >
                              <p className="text-xs font-medium text-zinc-100">启用视觉索引？</p>
                              <p className="mt-1 text-[11px] leading-5 text-zinc-400">页面或图片会发送给已配置的视觉模型并产生费用，每次最多分析 20 张。</p>
                              <div className="mt-2.5 flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setVisualConfirmId(null)}
                                  className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setVisualConfirmId(null);
                                    void enableVisual(file);
                                  }}
                                  className="rounded bg-cyan-500/15 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50"
                                >
                                  继续
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {file.visualEnabled && (
                      <details className="mt-1 text-[11px] text-zinc-400">
                        <summary className="w-fit cursor-pointer rounded hover:text-cyan-300 focus-visible:outline focus-visible:outline-cyan-400">处理详情</summary>
                        <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs leading-6" aria-live="polite">
                          <p>{visualLabel}</p>
                          {visualLabel === "视觉：未执行" && <p className="text-amber-300">尚无视觉处理记录，现有索引仅包含文本。请更新处理服务后，点击右侧重新入库按钮。</p>}
                          {file.visualGeneration && !visualProgress && <p className="text-zinc-500">此次处理未记录详细进度，重新入库后可查看实时过程。</p>}
                          <p className="text-zinc-500">流程：解析文件 → 渲染页面 / 提取图片 → 模型分析 → 写入索引</p>
                          {visualProgress && <p>
                            共 {visualProgress.total} 个页面 / 图片 · 已处理 {visualProgress.processed}
                            {` · 分析成功 ${visualProgress.analyzed} · 失败 ${visualProgress.failed} · 跳过 ${visualProgress.skipped}`}
                            {visualRunning && visualProgress.currentPage ? ` · 当前第 ${visualProgress.currentPage} 页` : ""}
                          </p>}
                          <p className="text-zinc-500">每次最多分析 20 张；超出数量或处理时间限制的内容会跳过。</p>
                          {file.visualGeneration?.warnings?.length ? <p className="text-amber-300">部分页面未完成分析，请检查模型配置或重新入库。</p> : null}
                        </div>
                      </details>
                    )}
                    {file.job?.status === "dead" && file.job.last_error && (
                      <div className="mt-0.5 truncate text-xs text-rose-300" title={file.job.last_error}>
                        {file.job.last_error}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" title="重新入库" aria-label={`重新入库 ${file.fileName}`} disabled={busy || status.pending} onClick={() => void reindex(file)} className="rounded-md border border-transparent p-1.5 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"><RotateCcw className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" title="删除" aria-label={`删除 ${file.fileName}`} disabled={busy} onClick={() => setDeleteTarget(file)} className="rounded-md border border-transparent p-1.5 text-zinc-500 hover:border-rose-900/60 hover:bg-rose-950/30 hover:text-rose-300 disabled:cursor-not-allowed disabled:text-zinc-700"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除文件"
        description={deleteTarget ? `删除「${deleteTarget.fileName}」及其全部索引？此操作不可恢复。` : ""}
        confirmLabel="删除"
        destructive
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </section>
  );
}
