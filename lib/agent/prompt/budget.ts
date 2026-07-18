import { estimateTokensFromText } from "@/lib/agent/runtime/budget";
import { truncateTextByTokens } from "@/lib/agent/runtime/tokenizer";
import type { PromptSegment } from "./segments";

export type PromptBudgetResult = {
  kept: PromptSegment[];
  omitted: PromptSegment[];
  estimatedTokens: number;
  decisions: PromptBudgetDecision[];
};

export type PromptBudgetDecision = {
  kind: PromptSegment["kind"];
  title: string;
  originalTokens: number;
  keptTokens: number;
  decision: "kept" | "truncated" | "omitted";
  reason?: "segment_budget" | "global_budget";
};

export function estimatePromptTokens(content: string) {
  return estimateTokensFromText(content);
}

export function truncatePromptContent(content: string, maxTokens: number) {
  if (maxTokens <= 0) return "";
  if (estimatePromptTokens(content) <= maxTokens) return content;

  const suffix = "\n\n...（prompt 段已按预算截断）";
  const suffixTokens = estimatePromptTokens(suffix);
  if (suffixTokens >= maxTokens) {
    return truncateTextByTokens(content, maxTokens).content;
  }
  const body = truncateTextByTokens(content, maxTokens - suffixTokens).content;
  return truncateTextByTokens(`${body}${suffix}`, maxTokens).content;
}

export function rankSegments(segments: PromptSegment[]) {
  return [...segments].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.kind.localeCompare(b.kind);
  });
}

export function applyPromptBudget(
  segments: PromptSegment[],
  options: { maxTokens: number },
): PromptBudgetResult {
  const kept: PromptSegment[] = [];
  const omitted: PromptSegment[] = [];
  const decisions: PromptBudgetDecision[] = [];
  let used = 0;
  const separatorTokens = estimatePromptTokens("\n\n");

  for (const segment of segments) {
    const originalTokens = estimatePromptTokens(segment.content);
    const ownLimit = Math.max(0, segment.tokenBudget ?? originalTokens);
    const ownBudgetedContent = truncatePromptContent(segment.content, ownLimit);
    const ownBudgetedTokens = estimatePromptTokens(ownBudgetedContent);
    const separatorCost = kept.length > 0 ? separatorTokens : 0;
    const remaining = Math.max(0, options.maxTokens - used - separatorCost);
    const globalBudgetedContent = truncatePromptContent(ownBudgetedContent, remaining);
    const keptTokens = estimatePromptTokens(globalBudgetedContent);

    if (globalBudgetedContent && keptTokens > 0) {
      kept.push({
        ...segment,
        content: globalBudgetedContent,
      });
      used += separatorCost + keptTokens;
      const truncatedByOwnBudget = ownBudgetedTokens < originalTokens;
      const truncatedByGlobalBudget = keptTokens < ownBudgetedTokens;
      decisions.push({
        kind: segment.kind,
        title: segment.title,
        originalTokens,
        keptTokens,
        decision: truncatedByOwnBudget || truncatedByGlobalBudget ? "truncated" : "kept",
        reason: truncatedByGlobalBudget
          ? "global_budget"
          : truncatedByOwnBudget
            ? "segment_budget"
            : undefined,
      });
    } else {
      omitted.push(segment);
      decisions.push({
        kind: segment.kind,
        title: segment.title,
        originalTokens,
        keptTokens: 0,
        decision: "omitted",
        reason: "global_budget",
      });
    }
  }

  return { kept, omitted, estimatedTokens: used, decisions };
}
