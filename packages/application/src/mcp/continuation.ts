import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  ToolCallEventData,
  ExecutionPlanData,
} from "@repo/contracts";
import { getToolCallKey } from "@/lib/agent/runtime";
import type { AgentLoopResult } from "@/lib/agent/runtime";
import type { ToolDefinition } from "@/lib/agent/tools/types";
import type { ToolRegistry } from "@/lib/agent/tools/registry";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

export type Continuation = {
  requestId: string;
  sessionId?: string;
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools: string[];
  pending: ToolCallEventData[];
  fingerprints: Record<string, string>;
  retrievalPlan?: RetrievalPlan;
  evidenceBundles: NonNullable<AgentLoopResult["evidenceBundles"]>;
  capabilities: string[];
  sources?: import("@repo/contracts").ToolSourceData[];
  remainingIterations: number;
  executedToolKeys?: string[];
  spentTokens?: number;
  retrievalCalls?: Array<[string, number]>;
  plan?: ExecutionPlanData;
  planStep?: number;
  planControl?: import("@repo/contracts").PlanExecutionControlData;
};
export type ConfirmationResponse = {
  events: AgentEvent[];
  pending: boolean;
  continuationError?: string;
};
export interface ConfirmationStore {
  create(userId: string, state: Continuation): Promise<string>;
  claim(
    userId: string,
    token: string,
    callId: string,
  ): Promise<{ state: Continuation; response?: ConfirmationResponse }>;
  save(
    userId: string,
    token: string,
    state: Continuation,
    callId: string,
    response: ConfirmationResponse,
  ): Promise<void>;
  release(userId: string, token: string): Promise<void>;
}
export function toolFingerprint(tool: ToolDefinition) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: tool.name,
        schema: tool.input_schema,
        runtime: tool.runtime,
        risk: tool.riskLevel,
        revision: tool.configurationRevision,
      }),
    )
    .digest("hex");
}
export function checkpoint(
  input: Omit<
    Continuation,
    "messages" | "pending" | "fingerprints" | "evidenceBundles" | "capabilities"
  >,
  result: AgentLoopResult,
  registry: ToolRegistry,
): Continuation {
  const pending = result.trace.steps.flatMap((step) =>
    step.type === "tool" && ["pending_confirmation", "awaiting_user_input"].includes(String(step.metadata?.status))
      ? [
          {
            id: step.toolCallId!,
            name: step.name,
            input: step.input,
            ok: false,
            content: step.contentSummary,
            metadata: step.metadata,
          },
        ]
      : [],
  );
  if (!pending.length || pending.some((call) => !call.id))
    throw new Error("无法保存待确认的工具调用");
  const settled = result.trace.steps.flatMap((step) =>
    step.type === "tool" && step.ok
      ? [
          getToolCallKey({
            type: "tool_use",
            id: step.toolCallId ?? "",
            name: step.name,
            input: step.input,
          }),
        ]
      : [],
  );
  const counts = new Map(input.retrievalCalls ?? []);
  for (const step of result.trace.steps) {
    if (
      step.type === "tool" &&
      registry.get(step.name)?.outputPolicy.retrieval &&
      ![
        "pending_confirmation",
        "retrieval_budget_skipped",
        "orchestration_prerequisite_missing",
      ].includes(String(step.metadata?.status))
    )
      counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  }
  const priorResults = new Map((input.planControl?.priorStepResults ?? []).map(step => [step.stepId, step]));
  for (const step of result.trace.steps) {
    if (step.type === "plan" && step.stepId && step.phase === "verified" && (step.status === "completed" || step.status === "skipped")) priorResults.set(step.stepId, { stepId: step.stepId, status: step.status, resultSummary: step.resultSummary });
  }
  return {
    ...input,
    planControl: input.plan ? { ...input.planControl, priorStepResults: Array.from(priorResults.values()) } : undefined,
    executedToolKeys: Array.from(
      new Set([...(input.executedToolKeys ?? []), ...settled]),
    ),
    spentTokens: (input.spentTokens ?? 0) + result.metrics.estimatedTokensSpent,
    retrievalCalls: Array.from(counts.entries()),
    messages: result.loopMessages,
    pending,
    fingerprints: Object.fromEntries(
      pending.map((call) => {
        const tool = registry.get(call.name);
        if (!tool) throw new Error("待确认工具不可用");
        return [call.id, toolFingerprint(tool)];
      }),
    ),
    evidenceBundles: result.evidenceBundles ?? [],
    capabilities: result.usedCapabilities ?? [],
  };
}
export function confirmationEvents(
  state: Continuation,
  token: string,
): AgentEvent[] {
  return state.pending.map((call) => ({
    type: "tool_call",
    toolCall: {
      ...call,
      metadata: {
        ...call.metadata,
        confirmationToken: token,
        parentRequestId: state.requestId,
      },
    },
  }));
}
export function replaceToolResult(
  state: Continuation,
  id: string,
  content: string,
  ok: boolean,
) {
  let replaced = false;
  state.messages = state.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== "tool_result" || block.tool_use_id !== id)
          return block;
        replaced = true;
        return { ...block, content, is_error: !ok };
      }),
    };
  });
  if (!replaced) throw new Error("确认上下文已失效，请重新发起请求");
}
