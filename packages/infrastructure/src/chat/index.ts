import type { ChatApplicationDependencies } from "@repo/application/chat/ports";
import { createChatSessionAdapter } from "./session-adapter";
import { createChatTelemetryAdapter } from "./telemetry-adapter";
import { createChatTraceAdapter } from "./trace-adapter";
import { createChatUserContextAdapter } from "./user-context-adapter";

export function createProductionChatDependencies(): ChatApplicationDependencies {
  return {
    userContext: createChatUserContextAdapter(),
    sessions: createChatSessionAdapter(),
    traces: createChatTraceAdapter(),
    telemetry: createChatTelemetryAdapter(),
  };
}
