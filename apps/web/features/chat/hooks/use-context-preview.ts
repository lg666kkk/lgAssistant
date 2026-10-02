"use client";

import { useEffect, useState } from "react";
import type { ChatModelId, ContextUsageEventData } from "@repo/contracts";
import { authFetch } from "@web/lib/auth/client";

type UseContextPreviewInput = {
  enabled: boolean;
  userId?: string;
  contextRevision: number;
  modelConfigKey: string;
  sessionId?: string;
  modelId: ChatModelId;
  webSearchEnabled: boolean;
  draftText: string;
  imageCount: number;
  isRunning: boolean;
};

type PreviewState = {
  identity: string;
  usage: ContextUsageEventData | null;
  error: string | null;
};

export function useContextPreview(input: UseContextPreviewInput) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const identity = JSON.stringify([
    input.userId, input.sessionId, input.modelId, input.modelConfigKey,
    input.contextRevision, input.webSearchEnabled, input.imageCount, input.draftText,
  ]);

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
        if (!controller.signal.aborted && payload.usage) setPreview({ identity, usage: payload.usage, error: null });
      }).catch((error) => {
        if (controller.signal.aborted) return;
        setPreview({ identity, usage: null, error: "上下文预估失败，请稍后重试" });
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

  return preview?.identity === identity
    ? { usage: preview.usage, error: preview.error }
    : { usage: null, error: null };
}
