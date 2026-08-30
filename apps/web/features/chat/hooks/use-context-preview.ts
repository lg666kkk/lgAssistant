"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChatModelId, ContextUsageEventData } from "@repo/contracts";
import { authFetch } from "@web/lib/auth/client";

type UseContextPreviewInput = {
  enabled: boolean;
  sessionId?: string;
  modelId: ChatModelId;
  webSearchEnabled: boolean;
  draftText: string;
  imageCount: number;
  isRunning: boolean;
};

type PreviewState = {
  identity: string;
  usage: ContextUsageEventData;
};

export function useContextPreview(input: UseContextPreviewInput) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const identity = useMemo(
    () => [
      input.sessionId ?? "new",
      input.modelId,
      input.webSearchEnabled ? "web" : "offline",
      input.imageCount,
    ].join(":"),
    [input.imageCount, input.modelId, input.sessionId, input.webSearchEnabled],
  );

  useEffect(() => {
    if (!input.enabled || !input.modelId || input.isRunning) return;

    const controller = new AbortController();
    const debounceMs = input.draftText || input.imageCount > 0 ? 450 : 0;
    const timer = window.setTimeout(() => {
      void authFetch("/api/chat/context-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sessionId,
          model: input.modelId,
          enableWebSearch: input.webSearchEnabled,
          draftText: input.draftText,
          imageCount: input.imageCount,
        }),
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "上下文预估失败");
        }
        const payload = await response.json() as { usage?: ContextUsageEventData };
        if (payload.usage) setPreview({ identity, usage: payload.usage });
      }).catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("刷新上下文预估失败:", error);
      });
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    identity,
    input.draftText,
    input.enabled,
    input.imageCount,
    input.isRunning,
    input.modelId,
    input.sessionId,
    input.webSearchEnabled,
  ]);

  return preview?.identity === identity ? preview.usage : null;
}
