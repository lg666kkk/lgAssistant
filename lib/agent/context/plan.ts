import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { estimateTokens } from "@/lib/agent/runtime/budget";
import type { ChatModelId } from "@/lib/agent/models";
import type { PromptPipeResult } from "@/lib/agent/prompt/pipe";
import type { PromptSegment } from "@/lib/agent/prompt/segments";
import type { ContextPlan, ContextPlanSource, ContextTrust } from "./types";

export const CONTEXT_POLICY = { id: "default-chat", version: "2026-07-18.1" } as const;

function hashContent(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function segmentTrust(segment: PromptSegment): ContextTrust {
  if (segment.trust) return segment.trust;
  if (segment.source === "system" || segment.source === "runtime") return "trusted";
  if (segment.source === "user") return "user";
  return "external";
}

function segmentKind(segment: PromptSegment): ContextPlanSource["kind"] {
  if (segment.kind === "memory") return "memory";
  if (segment.kind === "retrieval-plan" || segment.source === "knowledge") return "retrieval";
  return "system";
}

export function buildContextPlan(input: {
  model: ChatModelId;
  windowTokens: number;
  outputReserveTokens: number;
  messages: Anthropic.MessageParam[];
  originalMessageCount: number;
  historySource: ContextPlan["history"]["source"];
  tools: Anthropic.Tool[];
  prompt: PromptPipeResult;
  snapshotId?: string;
}): ContextPlan {
  const allSegments = [...input.prompt.segments, ...input.prompt.omittedSegments];
  const remainingSegments = [...allSegments];
  const sources = input.prompt.decisions.map((decision, index): ContextPlanSource => {
    const segmentIndex = remainingSegments.findIndex(
      (segment) => segment.kind === decision.kind && segment.title === decision.title,
    );
    const segment = segmentIndex >= 0
      ? remainingSegments.splice(segmentIndex, 1)[0]
      : allSegments[index];
    return {
      id: `segment:${index}:${decision.kind}`,
      kind: segment ? segmentKind(segment) : "system",
      trust: segment ? segmentTrust(segment) : "trusted",
      priority: segment?.priority ?? 0,
      originalTokens: decision.originalTokens,
      keptTokens: decision.keptTokens,
      decision: decision.decision,
      reason: decision.reason,
      contentHash: hashContent(segment?.content ?? ""),
    };
  });

  const messageTokens = estimateTokens(input.messages);
  const toolSchemaTokens = estimateTokens(input.tools);
  sources.push({
    id: "conversation-history",
    kind: "history",
    trust: "user",
    priority: 100,
    originalTokens: messageTokens,
    keptTokens: messageTokens,
    decision: "kept",
    reason: input.historySource,
    contentHash: hashContent(input.messages),
  });
  if (input.tools.length > 0) {
    sources.push({
      id: "tool-schemas",
      kind: "tool_schema",
      trust: "trusted",
      priority: 100,
      originalTokens: toolSchemaTokens,
      keptTokens: toolSchemaTokens,
      decision: "kept",
      contentHash: hashContent(input.tools),
    });
  }

  const systemTokens = estimateTokens(input.prompt.systemPrompt);
  return {
    id: crypto.randomUUID(),
    snapshotId: input.snapshotId,
    policy: CONTEXT_POLICY,
    model: input.model,
    windowTokens: input.windowTokens,
    outputReserveTokens: input.outputReserveTokens,
    history: {
      source: input.historySource,
      originalMessages: input.originalMessageCount,
      keptMessages: input.messages.length,
    },
    sources,
    totals: {
      systemTokens,
      messageTokens,
      toolSchemaTokens,
      totalTokens: systemTokens + messageTokens + toolSchemaTokens,
    },
    createdAt: new Date().toISOString(),
  };
}
