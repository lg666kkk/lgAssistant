import type Anthropic from "@anthropic-ai/sdk";
import type { AgentTrace, MemoryConsolidationTraceStep } from "@/lib/agent/runtime/trace";
import type { ContextSnapshot } from "@/lib/agent/context/types";
import type { ResolvedUserLlmModel } from "@/lib/llm/types";
import type { MemoryExecutionConfig } from "@/lib/memory-config/types";
import type { UserProfileSnapshot } from "@/lib/user-profile/types";
import type { ExternalToolsPort } from "../mcp/ports";

export type KnowledgeProfileSnapshot = {
  profile: string;
  sourceHash: string;
  indexVersion: string;
  updatedAt?: string;
};

export type HydratedChatContext = {
  messages: Anthropic.MessageParam[];
  source: "client" | "snapshot" | "redis" | "database";
  originalMessageCount: number;
  snapshot: ContextSnapshot | null;
};

export interface ChatUserContextPort {
  resolveModel(userId: string, modelId?: string): Promise<ResolvedUserLlmModel>;
  resolveMemoryConfig(userId: string): Promise<MemoryExecutionConfig | null>;
  resolveUserProfile(userId: string): Promise<UserProfileSnapshot>;
  readKnowledgeProfile(userId: string): Promise<KnowledgeProfileSnapshot | null>;
}

export interface ChatSessionPort {
  resolveLoopMessages(input: {
    userId: string;
    sessionId?: string;
    messages: Anthropic.MessageParam[];
  }): Promise<HydratedChatContext>;
  persistTurn(input: {
    userId: string;
    sessionId?: string;
    userMessage?: string;
    assistantMessage?: string;
  }): Promise<void>;
  createSnapshot(input: {
    previous?: ContextSnapshot;
    userId: string;
    sessionId: string;
    model: string;
    messages: Anthropic.MessageParam[];
  }): ContextSnapshot;
  saveSnapshot(snapshot: ContextSnapshot): Promise<void>;
  updateSystemPrompt(input: {
    userId: string;
    sessionId: string;
    systemPrompt: string;
  }): Promise<void>;
}

export interface ChatTracePort {
  save(trace: AgentTrace, userId: string): Promise<void>;
  appendMemoryConsolidation(
    requestId: string,
    userId: string,
    step: Omit<MemoryConsolidationTraceStep, "index">,
  ): Promise<void>;
}

export type ExternalObservationPort = {
  update(input: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    statusMessage?: string;
  }): void;
  end(): void;
};

export type ExternalTracePort = {
  id?: string;
  update(input: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    statusMessage?: string;
  }): void;
  setTraceIO(input: { input?: unknown; output?: unknown }): void;
  startObservation(
    name: string,
    input?: {
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
      level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
      statusMessage?: string;
    },
    options?: { asType?: string },
  ): ExternalObservationPort;
};

export interface ChatTelemetryPort {
  withTrace<T>(
    input: {
      userId: string;
      name: string;
      sessionId?: string;
      traceInput?: unknown;
      metadata?: Record<string, unknown>;
      tags?: string[];
    },
    callback: (scope: {
      trace: ExternalTracePort;
      reportOnlineScores(trace: AgentTrace): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

export type ChatApplicationDependencies = {
  externalTools?: ExternalToolsPort;
  userContext: ChatUserContextPort;
  sessions: ChatSessionPort;
  traces: ChatTracePort;
  telemetry: ChatTelemetryPort;
};
