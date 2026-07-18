import type Anthropic from "@anthropic-ai/sdk";

export type ContextTrust = "trusted" | "user" | "external";
export type ContextDecision = "kept" | "truncated" | "summarized" | "omitted";

export type ContextPlanSource = {
  id: string;
  kind: "system" | "history" | "memory" | "retrieval" | "tool_schema";
  trust: ContextTrust;
  priority: number;
  originalTokens: number;
  keptTokens: number;
  decision: ContextDecision;
  reason?: string;
  contentHash: string;
};

export type ContextPlan = {
  id: string;
  snapshotId?: string;
  policy: { id: string; version: string };
  model: string;
  windowTokens: number;
  outputReserveTokens: number;
  history: {
    source: "client" | "snapshot" | "redis" | "database";
    originalMessages: number;
    keptMessages: number;
  };
  sources: ContextPlanSource[];
  totals: {
    systemTokens: number;
    messageTokens: number;
    toolSchemaTokens: number;
    totalTokens: number;
  };
  createdAt: string;
};

export type ContextSnapshot = {
  id: string;
  userId: string;
  sessionId: string;
  version: number;
  model: string;
  policyVersion: string;
  summary: string;
  messages: Anthropic.MessageParam[];
  artifactRefs: string[];
  unresolvedItems: string[];
  sourceMessageCount: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};
