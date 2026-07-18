import type { MemoryRecord } from "./types";

function countMetadata(records: MemoryRecord[], key: string) {
  return records.reduce<Record<string, number>>((counts, record) => {
    const value = record.metadata[key];
    if (typeof value !== "string") return counts;
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

// The payload intentionally excludes keys, content, and evidence excerpts.
export function summarizeMemoryConsolidation(records: MemoryRecord[]) {
  return {
    persistedCount: records.length,
    writeActions: countMetadata(records, "writeAction"),
    memoryTypes: records.reduce<Record<string, number>>((counts, record) => {
      counts[record.type] = (counts[record.type] ?? 0) + 1;
      return counts;
    }, {}),
    sources: records.reduce<Record<string, number>>((counts, record) => {
      counts[record.source] = (counts[record.source] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
