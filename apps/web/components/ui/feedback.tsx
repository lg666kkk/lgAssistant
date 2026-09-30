"use client";

import { AlertCircle, CheckCircle2, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

type MessageTone = "success" | "error" | "warning" | "info";

const toneStyles: Record<MessageTone, { icon: typeof Info; className: string; label: string }> = {
  success: { icon: CheckCircle2, className: "border-emerald-800/80 bg-emerald-950/90 text-emerald-200", label: "成功" },
  error: { icon: XCircle, className: "border-rose-800/80 bg-rose-950/95 text-rose-200", label: "错误" },
  warning: { icon: AlertCircle, className: "border-amber-800/80 bg-amber-950/95 text-amber-200", label: "提示" },
  info: { icon: Info, className: "border-cyan-800/80 bg-slate-900/95 text-cyan-100", label: "提示" },
};

export function Message({
  children,
  tone = "info",
  onClose,
  duration = 5000,
  className = "",
}: {
  children: ReactNode;
  tone?: MessageTone;
  onClose?: () => void;
  duration?: number;
  className?: string;
}) {
  const styles = toneStyles[tone];
  const Icon = styles.icon;

  useEffect(() => {
    if (!onClose || duration <= 0) return;
    const timer = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(timer);
  }, [duration, onClose]);

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm shadow-lg shadow-black/10 ${styles.className} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{children}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label={`关闭${styles.label}`} className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-70 transition hover:bg-white/10 hover:opacity-100">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive = false,
  busy = false,
  children,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  children?: ReactNode;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const isBusy = busy || submitting;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = () => {
    if (!isBusy) onClose();
  };

  const confirm = async () => {
    if (isBusy) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-slate-700/80 bg-slate-900 p-0 text-slate-100 shadow-2xl shadow-black/60 backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm"
    >
      <div className="p-5">
        <h2 id="confirm-dialog-title" className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-400">{description}</p>}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={isBusy} onClick={close} className="rounded-lg px-3.5 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50">{cancelLabel}</button>
          <button type="button" disabled={isBusy} onClick={() => void confirm()} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${destructive ? "bg-rose-600 hover:bg-rose-500" : "bg-cyan-600 hover:bg-cyan-500"}`}>
            {isBusy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {isBusy ? "处理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
