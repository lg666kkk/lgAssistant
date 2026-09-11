"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { AuthForm } from "./auth-form";

export function AuthDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="auth-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[420px] overflow-y-auto rounded-xl bg-transparent p-0 text-white backdrop:bg-black/65 backdrop:backdrop-blur-sm"
      style={{ colorScheme: "dark" }}
    >
      <div className="relative">
        <button type="button" onClick={onClose} aria-label="关闭登录弹窗" className="absolute right-3 top-3 z-10 rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white">
          <X className="h-5 w-5" />
        </button>
        <AuthForm onSuccess={onClose} />
      </div>
    </dialog>
  );
}
