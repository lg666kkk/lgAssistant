export type ChatModelId = string;

export type ModelUsageBreakdown = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  estimatedCostCny: number;
  inputCacheHitCostCny: number;
  inputCacheMissCostCny: number;
  outputCostCny: number;
};

export interface ToolSourceData {
  title: string;
  notionPageId: string;
  pageUrl: string;
  similarity: number;
  excerpt: string;
}

export interface ToolCallEventData {
  name: string;
  input?: unknown;
  id: string;
  ok: boolean;
  content: string;
  truncated?: boolean;
  originalChars?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TextEvent {
  type: "text";
  content: string;
}

export interface ReasoningEventData {
  id: string;
  modelCallIndex: number;
  content: string;
}

export interface ReasoningEvent {
  type: "reasoning";
  reasoning: ReasoningEventData;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCall: ToolCallEventData;
}

export interface SourcesEvent {
  type: "sources";
  sources: ToolSourceData[];
}

export interface ModelUsageEventData extends ModelUsageBreakdown {
  model: ChatModelId;
  modelCallIndex: number;
}

export interface ModelUsageEvent {
  type: "model_usage";
  usage: ModelUsageEventData;
}

export interface ContextUsageEventData {
  model: ChatModelId;
  modelCallIndex: number;
  estimatedTokens: number;
  workingWindowTokens: number;
  modelWindowTokens: number;
  remainingTokens: number;
}

export interface ContextUsageEvent {
  type: "context_usage";
  usage: ContextUsageEventData;
}

export interface PlanProgressEventData {
  planId: string;
  stepId: string;
  goal: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  stepIndex: number;
  stepCount: number;
  failureReason?: string;
  resultSummary?: string;
}

export interface PlanStepData {
  id: string;
  goal: string;
  allowedTools: string[];
  successCriteria: string[];
}

export interface ExecutionPlanData {
  id: string;
  objective: string;
  steps: PlanStepData[];
}

export interface PlanStepResultData {
  stepId: string;
  status: "completed" | "skipped";
  resultSummary?: string;
}

export interface PlanExecutionControlData {
  startAtStep?: number;
  skipStepIds?: string[];
  priorStepResults?: PlanStepResultData[];
}

export interface PlanProposalEvent {
  type: "plan_proposal";
  plan: ExecutionPlanData;
}

export interface PlanProgressEvent {
  type: "plan_progress";
  plan: PlanProgressEventData;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  error: string;
}

export interface DoneEvent {
  type: "done";
}

export type AgentEvent =
  | TextEvent
  | ReasoningEvent
  | ToolCallEvent
  | SourcesEvent
  | ModelUsageEvent
  | ContextUsageEvent
  | PlanProposalEvent
  | PlanProgressEvent
  | ErrorEvent
  | DoneEvent;

export function serializeAgentEvent(event: AgentEvent): string {
  return `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`;
}
