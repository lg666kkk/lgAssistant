"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./toast.module.css";
import { createPortal } from "react-dom";

type Tone = "success" | "error" | "warning" | "info";
type Toast = { id: number; tone: Tone; content: ReactNode; duration: number };
type ToastInput = Omit<Toast, "id">;
const ToastContext = createContext<((input: ToastInput) => void) | null>(null);
const tonePaths = {
  success: "m4.5 8 2.2 2.2 4.8-4.8",
  error: "m5.5 5.5 5 5m0-5-5 5",
  warning: "M8 4.5v4M8 11h.01",
  info: "M8 7v4M8 4.5h.01",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const sequence = useRef(0);
  const show = useCallback((input: ToastInput) => {
    const next = { ...input, id: ++sequence.current };
    setToasts((current) => [...current.filter((item) => item.content !== input.content || item.tone !== input.tone), next].slice(-4));
  }, []);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);
  useEffect(() => {
    if (!toasts.length) return;
    const updateHost = () => setHost(document.querySelector<HTMLDialogElement>("dialog[open]") ?? document.body);
    updateHost();
    // Native dialogs live above regular z-index layers. Keep notices visible and interactive.
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"], childList: true });
    return () => observer.disconnect();
  }, [toasts.length]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {host && createPortal(<div aria-label="操作通知" className="pointer-events-none fixed left-1/2 top-[max(30dvh,env(safe-area-inset-top))] z-[100] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-3">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />)}
      </div>, host)}
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (paused || toast.duration <= 0) return;
    const timer = window.setTimeout(() => dismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
  }, [dismiss, paused, toast.duration, toast.id]);
  return (
    <div role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={`pointer-events-auto ${styles.toast} ${styles[toast.tone]} ${styles.enter}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className={styles.icon} aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="8" fill="currentColor" />
          <path d={tonePaths[toast.tone]} stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={styles.content}>{toast.content}</span>
    </div>
  );
}

/** Bridges existing operation-result state into the shared notification stack. */
export function ToastNotice({ children, tone = "info", duration }: {
  children: ReactNode;
  tone?: Tone;
  duration?: number;
}) {
  const show = useContext(ToastContext);
  const last = useRef<{ content: ReactNode; tone: Tone } | null>(null);
  useEffect(() => {
    if (!show || children === null || children === undefined || children === "") return;
    if (last.current?.content === children && last.current.tone === tone) return;
    last.current = { content: children, tone };
    show({ content: children, tone, duration: duration ?? (tone === "error" ? 8000 : 3000) });
  }, [children, duration, show, tone]);
  return null;
}
