import { useEffect, useState } from "react";
import { authFetch } from "@web/lib/auth/client";
import type { InstalledSkill } from "../model/slash-commands";

type Catalog = { userId?: string; items: InstalledSkill[]; loading: boolean; error: string | null };

export function useInstalledSkills(userId: string | undefined, open: boolean) {
  const [catalog, setCatalog] = useState<Catalog>({ items: [], loading: false, error: null });
  useEffect(() => {
    if (!userId || !open) return;
    const controller = new AbortController();
    setCatalog({ userId, items: [], loading: true, error: null });
    void (async () => {
      try {
        const response = await authFetch("/api/skills", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Skill 列表加载失败");
        const items: InstalledSkill[] = (data.skills ?? []).map((skill: InstalledSkill) => ({
          id: skill.id, name: skill.name, description: skill.description, enabled: skill.enabled,
        }));
        if (!controller.signal.aborted) setCatalog({ userId, items, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setCatalog({ userId, items: [], loading: false,
          error: error instanceof Error ? error.message : "Skill 列表加载失败" });
      }
    })();
    return () => controller.abort();
  }, [userId, open]);
  return catalog.userId === userId && userId ? catalog : { items: [], loading: false, error: null };
}
