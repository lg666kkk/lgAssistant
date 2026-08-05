import { redactSensitiveValue } from "@/lib/agent/rag/governance";

export type MemoryDebugStatus = "started" | "completed" | "skipped" | "failed";

export type MemoryDebugEntry = {
  phase: string;
  status: MemoryDebugStatus;
  details?: Record<string, unknown>;
};

export type MemoryDebugEventData = MemoryDebugEntry & {
  requestId: string;
  sessionId?: string;
  timestamp: string;
};

function stripUserIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUserIdentifiers);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["userid", "user_id"].includes(key.toLowerCase()))
      .map(([key, item]) => [key, stripUserIdentifiers(item)]),
  );
}

export function createMemoryDebugReporter(
  callback?: (entry: MemoryDebugEntry) => void,
) {
  return (entry: MemoryDebugEntry) => {
    try {
      callback?.(entry);
    } catch (error) {
      console.error("[memory-debug] 日志回调失败，已忽略:", error);
    }
  };
}

export function isMemoryDebugEnabled() {
  return process.env.MEMORY_DEBUG_LOGS === "true";
}

export function createMemoryDebugEvent(input: {
  requestId: string;
  sessionId?: string;
  entry: MemoryDebugEntry;
  now?: Date;
}): MemoryDebugEventData {
  return redactSensitiveValue(stripUserIdentifiers({
    requestId: input.requestId,
    sessionId: input.sessionId,
    timestamp: (input.now ?? new Date()).toISOString(),
    phase: input.entry.phase,
    status: input.entry.status,
    details: input.entry.details,
  })) as MemoryDebugEventData;
}

export function logMemoryDebugEvent(event: MemoryDebugEventData) {
  const requestLabel = event.requestId.slice(0, 8);
  console.info(
    `[memory-debug][${requestLabel}][${event.phase}][${event.status}]`,
    event,
  );
}
