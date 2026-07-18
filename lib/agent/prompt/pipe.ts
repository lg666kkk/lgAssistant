import { applyPromptBudget, rankSegments } from "./budget";
import { renderSegments } from "./render";
import { type PromptSegment, buildSegments } from "./segments";
import type { RetrievalPlan } from "@/lib/agent/rag/types";

export type PromptPipeInput = {
  userMessage: string;
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
};

export function buildPromptPipe(input: PromptPipeInput): PromptPipeResult {
  const segments = buildSegments(input);

  const ranked = rankSegments(segments);

  const budgeted = applyPromptBudget(ranked, {
    maxTokens: input.maxTokens ?? 3000,
  });

  return {
    systemPrompt: renderSegments(budgeted.kept),
    segments: budgeted.kept,
    omittedSegments: budgeted.omitted,
    estimatedTokens: budgeted.estimatedTokens,
  };
}
