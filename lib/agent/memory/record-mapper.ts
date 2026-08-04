import type {
  MemoryEvidence,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  MemoryType,
  MemoryWriteMetadata,
} from "./types";

const MEMORY_TYPES = new Set<MemoryType>([
  "preference",
  "fact",
  "profile",
  "project",
  "correction",
  "episodic",
]);
const MEMORY_SOURCES = new Set<MemorySource>(["user_explicit", "inferred", "tool"]);
const MEMORY_STATUSES = new Set<MemoryStatus>(["active", "invalidated", "conflicted"]);

function clampNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

export function memoryColumnsFromMetadata(metadata: MemoryWriteMetadata) {
  return {
    memory_type: MEMORY_TYPES.has(metadata.type as MemoryType) ? metadata.type : "fact",
    source: MEMORY_SOURCES.has(metadata.source as MemorySource)
      ? metadata.source
      : "inferred",
    confidence: clampNumber(metadata.confidence, 0.5),
    importance: clampNumber(metadata.importance, 0.5),
    status: MEMORY_STATUSES.has(metadata.status as MemoryStatus) ? metadata.status : "active",
    evidence: metadata.evidence ?? null,
  };
}

export function memoryRecordFromRow(row: any, fallbackLayer: "longterm" | "semantic") {
  const metadata = (row.metadata ?? {}) as MemoryWriteMetadata;
  const columns = memoryColumnsFromMetadata({
    ...metadata,
    type: row.memory_type ?? metadata.type,
    source: row.source ?? metadata.source,
    confidence: row.confidence ?? metadata.confidence,
    importance: row.importance ?? metadata.importance,
    status: row.status ?? metadata.status,
    evidence: row.evidence ?? metadata.evidence,
  });

  const record: MemoryRecord = {
    id: row.id,
    key: row.key,
    layer: row.layer ?? fallbackLayer,
    type: columns.memory_type as MemoryType,
    source: columns.source as MemorySource,
    confidence: columns.confidence,
    importance: columns.importance,
    status: columns.status as MemoryStatus,
    content: row.content,
    evidence: columns.evidence as MemoryEvidence | null,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    validFrom: row.valid_from ?? row.created_at,
    validTo: row.valid_to ?? null,
    lastAccessedAt: row.last_accessed_at ?? null,
  };
  if (row.similarity != null) record.score = Number(row.similarity);
  // 只在行里真的有 version 时才带上：缺列时留 undefined，写入侧据此放弃版本校验。
  if (row.version != null && Number.isFinite(Number(row.version))) {
    record.version = Number(row.version);
  }
  return record;
}
