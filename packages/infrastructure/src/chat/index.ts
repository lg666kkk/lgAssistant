import type { ChatApplicationDependencies } from "@repo/application/chat/ports";
import { createChatSessionAdapter } from "./session-adapter";
import { createChatTelemetryAdapter } from "./telemetry-adapter";
import { createChatTraceAdapter } from "./trace-adapter";
import { createChatUserContextAdapter } from "./user-context-adapter";
import { createManagedMcpToolsPort } from "../mcp/user-config";

export function createProductionChatDependencies(): ChatApplicationDependencies {
  return {
    externalTools: createManagedMcpToolsPort(),
    userContext: createChatUserContextAdapter(),
    sessions: createChatSessionAdapter(),
    traces: createChatTraceAdapter(),
    telemetry: createChatTelemetryAdapter(),
  };
}
