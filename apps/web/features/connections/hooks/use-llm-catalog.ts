"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@web/lib/auth/client";
import type { UserLlmCatalog } from "@/lib/llm/types";

export function useLlmCatalog(enabled: boolean) {
  const [catalog, setCatalog] = useState<UserLlmCatalog | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      setCatalog(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/llm/providers", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取模型配置失败");
      setCatalog(data as UserLlmCatalog);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取模型配置失败");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { catalog, loading, error, reload };
}
