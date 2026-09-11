"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { useAuth } from "./use-auth";

/** Real pages remain browsable; only controls marked for local browsing bypass login. */
export function PrivatePageBoundary({ children }: { children: ReactNode }) {
  const { user, requestLogin } = useAuth();
  const intercept = (event: SyntheticEvent) => {
    if (user || !(event.target instanceof Element)) return;
    if (event.target.closest("[data-guest-browse]")) return;
    if (!event.target.closest("button, input, textarea, select, a, [role=button], [contenteditable=true], label")) return;
    event.preventDefault();
    event.stopPropagation();
    requestLogin();
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col"
      onClickCapture={intercept}
      onPasteCapture={intercept}
      onBeforeInputCapture={intercept}
      onPointerDownCapture={(event) => {
        if ((event.target as Element).closest("input, textarea, select, button:disabled")) intercept(event);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" || event.key === " " || (event.target as Element).matches("input, textarea, select")) {
          if (event.key !== "Tab" && event.key !== "Escape") intercept(event);
        }
      }}
      onDropCapture={(event) => { if (!user) { event.preventDefault(); event.stopPropagation(); requestLogin(); } }}
      onDragOverCapture={(event) => { if (!user) event.preventDefault(); }}
    >
      {!user && <div className="shrink-0 border-b border-slate-800/60 px-6 py-2 text-xs text-slate-500">可浏览功能，个人数据与配置登录后加载。</div>}
      {children}
    </div>
  );
}
