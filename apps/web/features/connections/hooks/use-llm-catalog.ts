"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@web/lib/auth/client";
import type { UserLlmCatalog } from "@/lib/llm/types";

export function useLlmCatalog(userId?: string) {
  const [catalog, setCatalog] = useState<UserLlmCatalog | null>(null);
  const [loading, setLoading] = useState(Boolean(userId));
  const [error, setError] = useState<string | null>(null);

  const generation = useRef({ id: 0 });
  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current.id;
    if (!userId) {
      setCatalog(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/llm/providers", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取模型配置失败");
      if (generation.current.id === requestGeneration) setCatalog(data as UserLlmCatalog);
    } catch (loadError) {
      if (generation.current.id === requestGeneration) setError(loadError instanceof Error ? loadError.message : "读取模型配置失败");
    } finally {
      if (generation.current.id === requestGeneration) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    const requests = generation.current;
    setCatalog(null);
    void reload();
    return () => { requests.id++; };
  }, [reload]);

  return { catalog, loading, error, reload };
}
