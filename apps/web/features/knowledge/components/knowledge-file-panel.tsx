"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { authFetch } from "@web/lib/auth/client";
import { ConfirmDialog } from "@web/components/ui/feedback";

// 与 lib/knowledge/file-parsers.ts 保持一致；不直接引用以免把 node 依赖打进客户端。
const ACCEPTED_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt", ".html", ".htm", ".docx"];
const FORMAT_LABELS = ["PDF", "Markdown", "TXT", "HTML", "DOCX"];
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
  index: { chunk_count: number; last_synced_at: string; metadata?: { visual_status?: string; visual_warnings?: string[] } } | null;
  job: { status: string; last_error: string | null; attempts: number } | null;
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
    if (!window.confirm('启用视觉索引会将页面/图片发送给你配置的视觉模型，并产生模型费用。每次最多分析 20 张，超出部分标记未分析。继续？')) return;
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
            <span className="px-1 py-0.5">单个文件 ≤ 20MB；扫描 PDF 需启用视觉索引并配置视觉模型</span>
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
              return (
                <li key={file.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {status.pending
                    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-300" aria-hidden="true" />
                    : <FileText className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/api/knowledge/files/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-zinc-200 hover:text-sky-300"
                    >
                      {file.fileName}
                    </a>
                    <div className="text-xs text-zinc-600">
                      {formatSize(file.sizeBytes)} · {new Date(file.createdAt).toLocaleString()}
                    </div>
                    {file.visualEnabled && <div className="text-xs text-zinc-400">
                      视觉索引：{file.index?.metadata?.visual_status === 'ready' ? '已完成'
                        : file.index?.metadata?.visual_status === 'unconfigured' ? '需配置视觉模型'
                        : file.index?.metadata?.visual_status === 'partial' ? '部分完成，请检查限制/模型配置' : '等待处理'}
                    </div>}
                    {(file.fileKind === 'pdf' || file.fileKind === 'docx') && !file.visualEnabled && (
                      <button type="button" disabled={busy || status.pending}
                        onClick={() => void enableVisual(file)}
                        className="mt-1 rounded px-2 py-2 text-xs text-sky-300 hover:bg-zinc-800 disabled:opacity-50">
                        启用视觉索引（产生模型费用）
                      </button>
                    )}
                    {file.job?.status === "dead" && file.job.last_error && (
                      <div className="mt-0.5 truncate text-xs text-rose-300" title={file.job.last_error}>
                        {file.job.last_error}
                      </div>
                    )}
                  </div>
                  <span className={`shrink-0 text-xs ${status.tone}`}>{status.label}</span>
                  <button
                    type="button"
                    title="重新入库"
                    aria-label={`重新入库 ${file.fileName}`}
                    disabled={busy || status.pending}
                    onClick={() => void reindex(file)}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="删除"
                    aria-label={`删除 ${file.fileName}`}
                    disabled={busy}
                    onClick={() => setDeleteTarget(file)}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-rose-300 disabled:cursor-not-allowed disabled:text-zinc-700"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
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
