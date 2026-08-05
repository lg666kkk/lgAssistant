import type { ToolSourceType } from "@/lib/agent/runtime";
import type { ChatModelId, ModelUsageBreakdown } from "@/lib/agent/models";
import type { MemoryDebugEventData } from "@/lib/agent/memory/debug";
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

export interface ToolCallEvent {
    type: "tool_call";
    toolCall: ToolCallEventData;
}

export interface SourcesEvent {
    type: "sources";
    sources: ToolSourceType[];
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

export interface MemoryDebugEvent {
  type: "memory_debug";
  memory: MemoryDebugEventData;
}

export type AgentEvent =
  | TextEvent
  | ToolCallEvent
  | SourcesEvent
  | ModelUsageEvent
  | ContextUsageEvent
  | PlanProposalEvent
  | PlanProgressEvent
  | MemoryDebugEvent
  | ErrorEvent
  | DoneEvent;

// 序列化为 SSE 格式：event:<类型> 行 + data:<JSON> 行 + 空行（\n\n）作为事件边界。
// event.type 直接复用为 SSE 的 event 名；data 里仍保留完整 JSON（含 type），前端解析更省事。
export function serializeEvent(event: AgentEvent): string {
  return `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`;
}

// 入队：将事件序列化后推入文本队列
export function enqueueEvent(
  event: AgentEvent,
  enqueueText: (text: string) => boolean,
): boolean {
  return enqueueText(serializeEvent(event));
}
