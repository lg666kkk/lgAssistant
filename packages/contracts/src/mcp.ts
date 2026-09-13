export type McpManagedTool = {
  name: string;
  description: string;
  enabled: boolean;
  approval: "always" | "read-only";
};

export type McpServerView = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tokenConfigured: boolean;
  tools: McpManagedTool[];
  updatedAt?: string;
};

export type McpServerDraft = {
  name: string;
  url: string;
  enabled: boolean;
  token?: string;
  clearToken?: boolean;
  tools: McpManagedTool[];
};

export type McpDiscoveryResult = {
  tools: Array<{ name: string; description: string }>;
  latencyMs: number;
};
