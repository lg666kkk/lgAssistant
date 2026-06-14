import { estimateTokensFromText } from "@/lib/agent/runtime/budget";
import type { PromptSegment } from "./segments";

export type PromptBudgetResult = {
  kept: PromptSegment[];
  omitted: PromptSegment[];
  estimatedTokens: number;
};

export function estimatePromptTokens(content: string) {
  return estimateTokensFromText(content);
}

export function truncatePromptContent(content: string, maxTokens: number) {
  const maxChars = Math.max(0, maxTokens) * 4;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n...（prompt 段已按预算截断）`;
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
  let used = 0;

  for (const segment of segments) {
    const tokens = estimatePromptTokens(segment.content);

    if (used + tokens <= options.maxTokens) {
      kept.push(segment);
      used += tokens;
      continue;
    }

    const remaining = Math.max(0, options.maxTokens - used);
    const segmentBudget = Math.min(segment.tokenBudget ?? remaining, remaining);

    if (segmentBudget > 0) {
      const content = truncatePromptContent(segment.content, segmentBudget);
      kept.push({
        ...segment,
        content,
      });
      used += estimatePromptTokens(content);
    } else {
      omitted.push(segment);
    }
  }

  return { kept, omitted, estimatedTokens: used };
}
