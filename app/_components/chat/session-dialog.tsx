"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";

export type SessionDialogState = {
  mode: "rename" | "delete";
  sessionId: string;
  title: string;
};

type SessionDialogProps = {
  dialog: SessionDialogState;
  onClose: () => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
};

export function SessionDialog({
  dialog,
  onClose,
  onRename,
  onDelete,
}: SessionDialogProps) {
  const [title, setTitle] = useState(dialog.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(dialog.title);
    setError(null);
  }, [dialog]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (dialog.mode === "rename") {
        await onRename(dialog.sessionId, title);
      } else {
        await onDelete(dialog.sessionId);
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const Icon = dialog.mode === "delete" ? Trash2 : Pencil;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-dialog-title"
        aria-describedby="session-dialog-description"
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              dialog.mode === "delete"
                ? "bg-rose-500/10 text-rose-300"
                : "bg-cyan-500/10 text-cyan-300"
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="session-dialog-title" className="text-base font-semibold text-slate-100">
              {dialog.mode === "delete" ? "删除会话" : "重命名会话"}
            </h2>
            <p id="session-dialog-description" className="mt-1 text-sm leading-6 text-slate-400">
              {dialog.mode === "delete"
                ? "删除后将无法恢复，该会话的消息和本地工具结果也会一并清理。"
                : "输入一个清晰的名称，方便之后快速找到这个会话。"}
            </p>
          </div>
        </div>

        {dialog.mode === "rename" ? (
          <div className="mt-5">
            <label htmlFor="session-title" className="mb-2 block text-xs font-medium text-slate-400">
              会话名称
            </label>
            <input
              id="session-title"
              autoFocus
              maxLength={60}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-500/70 focus:ring-2 focus:ring-cyan-500/10"
            />
            <div className="mt-1.5 text-right text-[11px] text-slate-600">
              {title.trim().length}/60
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-xl bg-slate-950/60 px-3.5 py-3 text-sm text-slate-300">
            <span className="block text-xs text-slate-500">即将删除</span>
            <span className="mt-1 block truncate font-medium">{dialog.title}</span>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="rounded-lg px-3.5 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || (dialog.mode === "rename" && !title.trim())}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
              dialog.mode === "delete"
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-cyan-600 hover:bg-cyan-500"
            }`}
          >
            {busy ? "处理中..." : dialog.mode === "delete" ? "确认删除" : "保存名称"}
          </button>
        </div>
      </form>
    </div>
  );
}
