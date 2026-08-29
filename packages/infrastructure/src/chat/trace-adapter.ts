import type { ChatTracePort } from "@repo/application/chat/ports";
import {
  appendMemoryConsolidationTraceStep,
  saveTrace,
} from "@/lib/agent/runtime/trace-store";

export function createChatTraceAdapter(): ChatTracePort {
  return {
    save: (trace, userId) => saveTrace(trace, userId),
    appendMemoryConsolidation: (requestId, userId, step) =>
      appendMemoryConsolidationTraceStep(requestId, userId, step),
  };
}
