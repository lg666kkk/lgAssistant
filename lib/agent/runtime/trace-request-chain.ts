type TraceRequestRow = {
  id: string;
  request_id: string;
  created_at: string;
  steps?: unknown;
};

/** Follow persisted confirmation links in both directions, never session membership alone. */
export function selectTraceRequestChain<T extends TraceRequestRow>(rows: T[], selected: T): T[] {
  const candidates = rows.some((row) => row.id === selected.id) ? rows : [...rows, selected];
  const links = candidates.flatMap((row) => {
    if (!Array.isArray(row.steps)) return [];
    return row.steps.flatMap((step: unknown) => {
      if (!step || typeof step !== "object") return [];
      const tool = step as { type?: unknown; metadata?: { parentRequestId?: unknown } };
      const parent = tool.metadata?.parentRequestId;
      return tool.type === "tool" && typeof parent === "string"
        ? [{ child: row.request_id, parent }]
        : [];
    });
  });
  const requestIds = new Set([selected.request_id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { child, parent } of links) {
      if (!requestIds.has(child) && !requestIds.has(parent)) continue;
      for (const id of [child, parent]) {
        if (requestIds.has(id)) continue;
        requestIds.add(id);
        changed = true;
      }
    }
  }
  return candidates.filter((row) => requestIds.has(row.request_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
