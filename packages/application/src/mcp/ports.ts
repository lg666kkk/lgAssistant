import type { ToolDefinition } from "@/lib/agent/tools/types";

/** Request-scoped external tools. Credentials and protocol types stay in infrastructure. */
export interface ExternalToolSession {
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export interface ExternalToolsPort {
  open(input: { userId: string; signal: AbortSignal }): Promise<ExternalToolSession>;
}
