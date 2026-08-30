import type Anthropic from "@anthropic-ai/sdk";
import type { ContextUsageBreakdown } from "@repo/contracts";
import { estimateTokens, estimateTokensFromText } from "./budget";

type ModelMessage = Anthropic.MessageParam;

type SystemSegment = {
  kind: string;
  content: string;
};

export function estimateModelRequestTokens(input: {
  messages: ModelMessage[];
  tools: Anthropic.Tool[];
  system?: string;
}) {
  return estimateTokens({
    messages: input.messages,
    system: input.system ?? "",
    tools: input.tools,
  });
}

const BREAKDOWN_KEYS: Array<keyof ContextUsageBreakdown> = [
  "systemTokens",
  "userProfileTokens",
  "memoryTokens",
  "retrievalPolicyTokens",
  "knowledgeRagTokens",
  "webRetrievalTokens",
  "conversationTokens",
  "toolCallTokens",
  "toolResultTokens",
  "toolSchemaTokens",
  "otherTokens",
];

function systemCategory(kind: string): keyof ContextUsageBreakdown {
  if (kind === "user-profile") return "userProfileTokens";
  if (["memory", "memory-operation", "memory-recall-hint"].includes(kind)) return "memoryTokens";
  if (["retrieval-plan", "tool-orchestration", "evidence-policy"].includes(kind)) return "retrievalPolicyTokens";
  if (kind === "task-context") return "knowledgeRagTokens";
  return "systemTokens";
}

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && "text" in item ? [String(item.text ?? "")] : [])
    .join("\n");
}

function toolResultCategory(
  toolName: string | undefined,
  content: unknown,
): keyof ContextUsageBreakdown {
  const text = contentText(content);
  const artifactTool = /^tool:\s*([^\s]+)/m.exec(text)?.[1];
  const effectiveTool = toolName === "read_tool_artifact" && artifactTool
    ? artifactTool
    : toolName;
  if (effectiveTool === "search_notes") return "knowledgeRagTokens";
  if (effectiveTool === "web_search" || effectiveTool === "web_fetch") return "webRetrievalTokens";
  if (effectiveTool === "recall_memory" || effectiveTool === "search_memory_history") return "memoryTokens";
  return "toolResultTokens";
}

function normalizeBreakdown(
  raw: ContextUsageBreakdown,
  totalTokens: number,
): ContextUsageBreakdown {
  const rawTotal = BREAKDOWN_KEYS.reduce((sum, key) => sum + raw[key], 0);
  if (rawTotal <= 0) return { ...raw, otherTokens: totalTokens };

  const scaled = BREAKDOWN_KEYS.map((key) => {
    const exact = raw[key] * totalTokens / rawTotal;
    return { key, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = totalTokens - scaled.reduce((sum, item) => sum + item.value, 0);
  scaled.sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; index < remaining; index += 1) {
    scaled[index % scaled.length].value += 1;
  }
  return Object.fromEntries(scaled.map(({ key, value }) => [key, value])) as ContextUsageBreakdown;
}

export function buildContextUsageBreakdown(input: {
  messages: ModelMessage[];
  tools: Anthropic.Tool[];
  system?: string;
  systemSegments?: SystemSegment[];
  totalTokens: number;
}): ContextUsageBreakdown {
  const raw = Object.fromEntries(BREAKDOWN_KEYS.map((key) => [key, 0])) as ContextUsageBreakdown;

  if (input.systemSegments?.length) {
    for (const segment of input.systemSegments) {
      raw[systemCategory(segment.kind)] += estimateTokensFromText(segment.content);
    }
    const renderedSystemTokens = estimateTokensFromText(input.system ?? "");
    const segmentTokens = input.systemSegments.reduce(
      (sum, segment) => sum + estimateTokensFromText(segment.content),
      0,
    );
    raw.otherTokens += Math.max(0, renderedSystemTokens - segmentTokens);
  } else {
    raw.systemTokens += estimateTokensFromText(input.system ?? "");
  }

  raw.toolSchemaTokens += estimateTokens(input.tools);

  const toolNames = new Map<string, string>();
  for (const message of input.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolNames.set(block.id, block.name);
      }
    }
  }

  for (const message of input.messages) {
    if (typeof message.content === "string") {
      raw.conversationTokens += estimateTokens(message);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        raw.toolCallTokens += estimateTokens(block);
      } else if (block.type === "tool_result") {
        raw[toolResultCategory(toolNames.get(block.tool_use_id), block.content)] += estimateTokens(block);
      } else {
        raw.conversationTokens += estimateTokens(block);
      }
    }
  }

  return normalizeBreakdown(raw, input.totalTokens);
}
