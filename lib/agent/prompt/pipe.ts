import {
  applyPromptBudget,
  estimatePromptTokens,
  rankSegments,
  type PromptBudgetDecision,
} from "./budget";
import { renderSegments } from "./render";
import { type PromptSegment, buildSegments } from "./segments";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

export type PromptPipeInput = {
  userMessage?: string;
  memoryOperation?: string;
  memory?: string;
  knowledge?: string;
  knowledgeMetadata?: Record<string, unknown>;
  webSearchEnabled?: boolean;
  currentDate?: string;
  retrievalPlan?: RetrievalPlan;
  maxTokens?: number;
};

export type PromptPipeResult = {
  systemPrompt: string;
  segments: PromptSegment[];
  omittedSegments: PromptSegment[];
  estimatedTokens: number;
  decisions: PromptBudgetDecision[];
};

function renderOrder(segments: PromptSegment[]) {
  const order: Record<string, number> = {
    identity: 0,
    safety: 10,
    "memory-operation": 15,
    "knowledge-search-policy": 20,
    "search-query-policy": 30,
    "web-search-policy": 40,
    "evidence-policy": 50,
    memory: 60,
    "retrieval-plan": 70,
    "task-context": 80,
  };
  return [...segments].sort((a, b) => {
    const stableDiff = Number(a.dynamic === true) - Number(b.dynamic === true);
    if (stableDiff !== 0) return stableDiff;
    return (order[a.kind] ?? 100) - (order[b.kind] ?? 100);
  });
}

export function buildPromptPipe(input: PromptPipeInput): PromptPipeResult {
  const segments = buildSegments(input);

  const ranked = rankSegments(segments);

  const budgeted = applyPromptBudget(ranked, {
    maxTokens: input.maxTokens ?? 3000,
  });
  const renderedSegments = renderOrder(budgeted.kept);
  const systemPrompt = renderSegments(renderedSegments);

  return {
    systemPrompt,
    segments: renderedSegments,
    omittedSegments: budgeted.omitted,
    estimatedTokens: estimatePromptTokens(systemPrompt),
    decisions: budgeted.decisions,
  };
}
