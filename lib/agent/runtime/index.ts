import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { requiresCitedEvidence } from "@/lib/agent/tools/grounding-policy";
import { missingToolPrerequisites } from "@/lib/agent/tools/orchestration";
import type { ToolGroundingMode } from "@/lib/agent/tools/types";
import {
  TokenBudget,
  estimateTokens,
  truncateToolContent,
} from "@/lib/agent/runtime/budget";
import {
  buildContextUsageBreakdown,
  estimateModelRequestTokens,
} from "@/lib/agent/runtime/context-usage";
import {
  AGENT_LOOP_OUTPUT_RESERVE,
  AGENT_LOOP_TOKEN_BUDGET,
  CONTEXT_COMPACTION_WINDOW_CAP,
} from "@/lib/agent/runtime/limits";
import {
  compactLoopMessagesSemantic,
} from "@/lib/agent/runtime/compaction";
import { saveToolArtifact } from "@/lib/agent/runtime/artifact-store";
import { createTrace, summarizeText } from "@/lib/agent/runtime/trace";
import { enqueueEvent } from "@/lib/agent/runtime/events";
import { sanitizeModelText } from "@/lib/agent/runtime/output-sanitizer";
import type { ToolCallEventData } from "@/lib/agent/runtime/events";
import {
  callModelWithProvider,
  generateTextWithProvider,
  type ModelTelemetryMetadata,
  streamTextWithProvider,
} from "@/lib/agent/runtime/model-provider";
import {
  calculateModelUsageCost,
  defaultChatModel,
  getModelContextWindowTokens,
  type ModelPricingCnyPerMillionTokens,
  type ChatModelId,
  type ModelUsageBreakdown,
} from "@/lib/agent/models";
import Anthropic from "@anthropic-ai/sdk";
import { ragConfig } from "@/lib/platform/config";
import { verifyGroundedAnswer } from "@/lib/agent/rag/answer-verifier";
import { mergeEvidenceBundles } from "@/lib/agent/rag/evidence";
import {
  isEvidenceBundle,
  type EvidenceBundle,
  type RetrievalPlan,
} from "@/lib/agent/rag/types";
import type { ContextPlan } from "@/lib/agent/context/types";
import { getActiveTraceId, startActiveObservation } from "@langfuse/tracing";
import { withSpanLabel } from "@/lib/agent/observability/span-labels";

// Anthropic SDK 真实类型——替代原来的 any，编译器现在能帮你检查每个字段
type ModelMessage = Anthropic.MessageParam;
type ModelContentBlock = Anthropic.Messages.ContentBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
type DeepSeekAssistantMessage = Anthropic.MessageParam & {
  reasoning_content?: string;
};

export type AgentLoopMetrics = {
  estimatedTokensSpent: number;
  modelCallCount: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  estimatedModelCostCny: number;
  toolCallCount: number;
  totalToolCost: number;
  toolDurations: Array<{
    name: string;
    durationMs?: number;
  }>;
};

import type {
  AgentTrace,
  ContextCompactionTraceStep,
  ModelTraceStep,
  RetrievalTraceStep,
  ToolTraceStep,
} from "@/lib/agent/runtime/trace";
import type { ToolSourceData } from "@repo/contracts";

export type AgentLoopStopReason =
  | "completed"
  | "aborted"
  | "error"
  | "awaiting_user_input"
  | "awaiting_tool_confirmation"
  | "max_tokens"
  | "token_budget_exceeded"
  | "repeated_tool_call"
  | "max_iterations";

export type AgentLoopResult = {
  loopMessages: ModelMessage[];
  completed: boolean;
  stopReason: AgentLoopStopReason;
  metrics: AgentLoopMetrics;
  trace: AgentTrace;
  evidenceBundles?: EvidenceBundle[];
  usedGroundingModes?: ToolGroundingMode[];
  toolEvidenceRequired?: boolean;
  usedCapabilities?: string[];
};

export type ToolSourceType = ToolSourceData;

interface DocContent {
  pageTitle?: unknown;
  pageId?: unknown;
  pageUrl?: unknown;
  similarity?: unknown;
  vectorScore?: unknown;
  keywordScore?: unknown;
  combinedScore?: unknown;
  rerankScore?: unknown;
  headingPath?: unknown;
  content?: unknown;
}

interface WebFetchContent {
  title?: unknown;
  url?: unknown;
  finalUrl?: unknown;
  status?: unknown;
  contentType?: unknown;
  method?: unknown;
  snippet?: unknown;
  text?: unknown;
  charCount?: unknown;
  returnedChars?: unknown;
  truncated?: unknown;
}

interface WebSearchContent {
  response?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      content?: unknown;
      score?: unknown;
    }>;
  };
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export function getToolCallKey(toolUse: ToolUseBlock): string {
  return JSON.stringify({
    name: toolUse.name,
    input: toolUse.input,
  });
}

export function extractText(content: ModelContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)   // TS 收窄到 TextBlock，.text 合法
    .join("");
}

export function extractToolUses(content: ModelContentBlock[]): ToolUseBlock[] {
  return content.filter(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
  );
}

export function appendToolResults(
  loopMessages: ModelMessage[],
  assistantResponse: Anthropic.Message & { reasoning_content?: string },
  toolResultBlocks: ToolResultBlock[],
): ModelMessage[] {
  return [
    ...loopMessages,
    // role 必须是字面量类型 "assistant" | "user"，不能是宽泛的 string
    {
      role: "assistant" as const,
      content: assistantResponse.content,
      ...(assistantResponse.reasoning_content
        ? { reasoning_content: assistantResponse.reasoning_content }
        : {}),
    } as DeepSeekAssistantMessage,
    { role: "user" as const, content: toolResultBlocks },
  ];
}

function getLatestToolResultTrigger(messages: ModelMessage[]) {
  const latestMessage = messages[messages.length - 1] as any;
  if (
    latestMessage?.role !== "user" ||
    !Array.isArray(latestMessage.content) ||
    !latestMessage.content.some((block: any) => block?.type === "tool_result")
  ) {
    return {
      trigger: "initial" as const,
      toolNames: [] as string[],
    };
  }

  const toolResultIds = new Set(
    latestMessage.content
      .filter((block: any) => block?.type === "tool_result")
      .map((block: any) => block.tool_use_id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
  );

  const previousAssistant = [...messages]
    .slice(0, -1)
    .reverse()
    .find((message: any) => message.role === "assistant" && Array.isArray(message.content)) as
    | { content: unknown[] }
    | undefined;

  const toolNames = previousAssistant?.content
    ?.filter((block: any) => block?.type === "tool_use" && toolResultIds.has(block.id))
    .map((block: any) => block.name)
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0) ?? [];

  return {
    trigger: "after_tools" as const,
    toolNames: Array.from(new Set(toolNames)),
  };
}

function buildAgentLoopTelemetry(input: {
  messages: ModelMessage[];
}) {
  const trigger = getLatestToolResultTrigger(input.messages);
  if (trigger.trigger === "initial") {
    return {
      functionId: "agent-loop-initial",
      trigger: trigger.trigger,
      triggeringTools: "",
    };
  }

  const toolSummary = trigger.toolNames.length > 0
    ? trigger.toolNames.slice(0, 5).join("+")
    : "unknown_tool";
  const overflow = trigger.toolNames.length > 5 ? "+more" : "";

  return {
    functionId: `agent-loop-after-tools:${toolSummary}${overflow}`,
    trigger: trigger.trigger,
    triggeringTools: trigger.toolNames.join(","),
  };
}

function compactTextHeadTail(text: string, maxChars: number) {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.75);
  const tail = Math.max(0, maxChars - head);
  return `${normalized.slice(0, head)}\n\n...（中间内容已省略，原文 ${normalized.length} 字符）...\n\n${normalized.slice(-tail)}`;
}

function compactTextPrefix(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function shapeWebFetchContent(toolResult: Awaited<ReturnType<typeof executeToolCall>>) {
  if (!toolResult.ok || !toolResult.data || typeof toolResult.data !== "object") {
    return undefined;
  }

  const page = toolResult.data as WebFetchContent;
  const text = typeof page.text === "string" ? page.text : "";
  const snippet = typeof page.snippet === "string" ? page.snippet : "";
  const title = typeof page.title === "string" && page.title.trim() ? page.title : "(无标题)";
  const finalUrl =
    typeof page.finalUrl === "string"
      ? page.finalUrl
      : typeof page.url === "string"
        ? page.url
        : "";
  const body = text || snippet || toolResult.content;
  const shapedBody = compactTextHeadTail(body, 3_500);

  return [
    "web_fetch 结果（已压缩给模型使用）",
    `标题：${title}`,
    finalUrl ? `链接：${finalUrl}` : undefined,
    typeof page.status === "number" ? `HTTP 状态：${page.status}` : undefined,
    typeof page.contentType === "string" ? `Content-Type：${page.contentType}` : undefined,
    typeof page.method === "string" ? `读取方式：${page.method}` : undefined,
    typeof page.charCount === "number" ? `原文字符数：${page.charCount}` : undefined,
    page.truncated === true ? "说明：原工具结果已截断。" : undefined,
    snippet ? `摘要：${snippet}` : undefined,
    "",
    "正文片段：",
    shapedBody,
  ]
    .filter((item) => item !== undefined)
    .join("\n");
}

function shapeWebSearchContent(toolResult: Awaited<ReturnType<typeof executeToolCall>>) {
  if (!toolResult.ok || !toolResult.data || typeof toolResult.data !== "object") {
    return undefined;
  }

      const data = toolResult.data as WebSearchContent;
  const results = data.response?.results ?? [];
  if (!Array.isArray(results) || results.length === 0) return undefined;

  return [
    "web_search 结果（已压缩给模型使用）",
    ...results.slice(0, 5).map((result, index) => {
      const title = typeof result.title === "string" ? result.title : "(无标题)";
      const url = typeof result.url === "string" ? result.url : "";
      const content = typeof result.content === "string" ? result.content : "";
      return `${index + 1}. ${title}\n链接：${url}\n摘要：${compactTextPrefix(content, 500)}`;
    }),
  ].join("\n\n");
}

function shapeToolResultContent(
  toolName: string,
  toolResult: Awaited<ReturnType<typeof executeToolCall>>,
) {
  if (toolName === "read_tool_artifact") {
    return truncateToolContent(toolResult.content, 4_000);
  }

  if (toolName === "search_notes") {
    return truncateToolContent(
      toolResult.content,
      ragConfig.maxContextTokens * 4,
    );
  }

  const shaped =
    toolName === "web_fetch"
      ? shapeWebFetchContent(toolResult)
      : toolName === "web_search"
        ? shapeWebSearchContent(toolResult)
        : undefined;

  return truncateToolContent(shaped ?? toolResult.content, 1_200);
}

const ARTIFACT_ELIGIBLE_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "search_notes",
]);

function shouldStoreToolArtifact(
  toolName: string,
  toolResult: Awaited<ReturnType<typeof executeToolCall>>,
  shapedResult: ReturnType<typeof truncateToolContent>,
) {
  if (!toolResult.ok || !ARTIFACT_ELIGIBLE_TOOLS.has(toolName)) return false;
  if (toolName === "web_fetch") return true;

  const rawDataSize =
    toolResult.data === undefined ? 0 : JSON.stringify(toolResult.data).length;
  return (
    shapedResult.truncated ||
    toolResult.content.length > 2_000 ||
    rawDataSize > 4_000
  );
}

async function maybeStoreToolArtifact(input: {
  toolUse: ToolUseBlock;
  toolResult: Awaited<ReturnType<typeof executeToolCall>>;
  shapedResult: ReturnType<typeof truncateToolContent>;
  scopeId?: string;
  userId?: string;
  requestId?: string;
}) {
  if (!shouldStoreToolArtifact(input.toolUse.name, input.toolResult, input.shapedResult)) {
    return undefined;
  }

  const artifact = await saveToolArtifact({
    userId: input.userId,
    scopeId: input.scopeId,
    requestId: input.requestId,
    toolCallId: input.toolUse.id,
    toolName: input.toolUse.name,
    input: input.toolUse.input,
    content: input.toolResult.content,
    data: input.toolResult.data,
    metadata: input.toolResult.metadata,
  });
  const compactSummary = truncateToolContent(input.shapedResult.content, 800);

  return {
    artifact,
    modelContent: [
      `${input.toolUse.name} 完整结果已保存到服务端本地 artifact。`,
      `artifact_id: ${artifact.id}`,
      `如需查看完整原文，请调用 read_tool_artifact({"artifactId":"${artifact.id}"}).`,
      "",
      "当前可用摘要：",
      compactSummary.content,
    ].join("\n"),
  };
}

const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.6;
const CONTEXT_COMPACTION_TARGET_RATIO = 0.3;

export async function callModel(
  messages: ModelMessage[],
  tools: Anthropic.Tool[],
  system?: string,
  onTextDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  model: ChatModelId = defaultChatModel,
  telemetryMetadata?: ModelTelemetryMetadata,
  telemetryFunctionId?: string,
  signal?: AbortSignal,
): Promise<Anthropic.Message & {
  reasoning_content?: string;
  pricing?: ModelPricingCnyPerMillionTokens;
  modelName?: string;
  providerName?: string;
  providerModelId?: string;
}> {
  const result = await callModelWithProvider({
    messages,
    tools,
    system,
    onTextDelta,
    onReasoningDelta,
    model,
    telemetryMetadata,
    telemetryFunctionId,
    signal,
  });

  return result as Anthropic.Message & {
    reasoning_content?: string;
    pricing?: ModelPricingCnyPerMillionTokens;
    modelName?: string;
    providerName?: string;
    providerModelId?: string;
  };
}

const COMPACTION_SYSTEM_PROMPT = `你负责压缩较早的对话上下文，供同一个 agent 继续完成当前任务。
请保留可执行状态、用户约束、关键决定、涉及文件、工具结果和未解决问题。
不要编造事实；不确定的信息请标注为“不确定”。
使用简洁 bullet，移除寒暄、重复表达和无关细节。`;

function buildCompactionPrompt(input: {
  digest: string;
  targetContextTokens: number;
  summaryTokenBudget: number;
  middleMessageCount: number;
}) {
  return `请压缩下面这段中间历史摘要。

必须返回 Markdown，并严格使用这些小节：
- 用户目标
- 重要约束
- 已完成工作
- 当前状态
- 重要文件和符号
- 工具结果和来源
- 未解决问题
- 下一步建议

压缩后的整体上下文目标：不超过约 ${input.targetContextTokens} tokens。
本摘要自身上限：约 ${input.summaryTokenBudget} tokens。
中间历史消息数：${input.middleMessageCount}

中间历史：
${input.digest}`;
}

export async function callCompressionModel(input: {
  signal?: AbortSignal;
  digest: string;
  targetContextTokens: number;
  summaryTokenBudget: number;
  middleMessageCount: number;
  model?: ChatModelId;
  telemetryMetadata?: ModelTelemetryMetadata;
}): Promise<string> {
  return generateTextWithProvider({
    model: input.model ?? defaultChatModel,
    abortSignal: input.signal,
    maxOutputTokens: Math.min(Math.max(256, input.summaryTokenBudget), 2_000),
    telemetryFunctionId: "conversation-context-compress",
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: buildCompactionPrompt(input),
    telemetryMetadata: {
      ...input.telemetryMetadata,
      operation: "conversation-context-compress",
      targetContextTokens: input.targetContextTokens,
      summaryTokenBudget: input.summaryTokenBudget,
      middleMessageCount: input.middleMessageCount,
    },
  });
}

export async function executeTools(
  toolUses: ToolUseBlock[],
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
  requestId?: string,
  conversationContext?: string[],
  precomputedResults: Map<
    string,
    Awaited<ReturnType<typeof executeToolCall>>
  > = new Map(),
  signal?: AbortSignal,
) {
  const toolResultBlocks: Array<ToolResultBlock> = [];
  const toolSources: Array<ToolSourceType> = [];
  const toolCalls: ToolCallEventData[] = [];
  const toolSteps: ToolTraceStep[] = [];
  const evidenceBundles: EvidenceBundle[] = [];
  const usedGroundingModes = new Set<ToolGroundingMode>();
  const usedCapabilities = new Set<string>();
  let toolEvidenceRequired = false;
  const toolMetrics: Array<{
    name: string;
    durationMs?: number;
    costPerUse: number;
  }> = [];

  const originalIndexById = new Map<string, number>();
  const seenBatchKeys = new Set<string>();
  const uniqueToolUses: ToolUseBlock[] = [];
  const duplicateExecutionResults: Array<{
    toolUse: ToolUseBlock;
    toolResult: Awaited<ReturnType<typeof executeToolCall>>;
  }> = [];

  toolUses.forEach((toolUse, index) => {
    originalIndexById.set(toolUse.id, index);
    const precomputed = precomputedResults.get(toolUse.id);
    if (precomputed) {
      duplicateExecutionResults.push({ toolUse, toolResult: precomputed });
      return;
    }
    const key = getToolCallKey(toolUse);
    if (seenBatchKeys.has(key)) {
      duplicateExecutionResults.push({
        toolUse,
        toolResult: {
          ok: false,
          toolName: toolUse.name,
          toolCallId: toolUse.id,
          content: `重复工具调用已跳过：${toolUse.name}`,
          error: `Duplicate tool call skipped: ${toolUse.name}`,
          metadata: {
            status: "duplicate_skipped",
            duplicateKey: key,
          },
        },
      });
      return;
    }
    seenBatchKeys.add(key);
    uniqueToolUses.push(toolUse);
  });

  const executionResults = [
    ...(await executeToolUsesWithScheduler(
      uniqueToolUses,
      toolRegistry,
      scopeId,
      userId,
      requestId,
      conversationContext,
      signal,
    )),
    ...duplicateExecutionResults,
  ].sort(
    (a, b) =>
      (originalIndexById.get(a.toolUse.id) ?? 0) -
      (originalIndexById.get(b.toolUse.id) ?? 0),
  );

  for (const { toolUse, toolResult } of executionResults) {
    const toolDefinition = toolRegistry.get(toolUse.name);
    const evidenceBundle =
      toolResult.data
      && typeof toolResult.data === "object"
      && "evidenceBundle" in toolResult.data
      && isEvidenceBundle(toolResult.data.evidenceBundle)
        ? toolResult.data.evidenceBundle
        : undefined;
    if (evidenceBundle) {
      // EvidenceBundle 描述证据本身，工具名由执行器最可靠地掌握。这里补充来源工具，
      // 后续 Trace 上报即可区分 web_search、web_fetch、search_notes，无需让每个
      // 工具重复维护一份可观测性字段。
      evidenceBundles.push({ ...evidenceBundle, toolName: toolUse.name });
    }
    if (toolResult.ok && toolDefinition) {
      usedGroundingModes.add(toolDefinition.outputPolicy.grounding);
      // 判据是“本轮拿到了必须被引用的证据”，不是“调用过要求引用的工具”。
      // 检索工具查不到内容时同样返回 ok:true（内容是“没有找到…”），若按调用
      // 成功计，会让一次空检索把整篇回答判成无据可依并整体替换掉。
      toolEvidenceRequired ||= toolDefinition.outputPolicy.citationRequired
        && (evidenceBundle?.evidences.length ?? 0) > 0;
      for (const capability of toolDefinition.capabilities) usedCapabilities.add(capability);
    }
    const durationMs =
      typeof toolResult.metadata?.durationMs === "number"
        ? toolResult.metadata.durationMs
        : undefined;

    const costPerUse =
      typeof toolResult.metadata?.costPerUse === "number"
        ? toolResult.metadata.costPerUse
        : 0;

    toolMetrics.push({
      name: toolUse.name,
      durationMs,
      costPerUse,
    });
    if (
      toolUse.name === "search_notes" &&
      toolResult.ok &&
      toolResult.data &&
      typeof toolResult.data === "object" &&
      "results" in toolResult.data
    ) {
      const results = toolResult.data.results;
      if (Array.isArray(results)) {
        for (const result of results) {
          let doc = result as DocContent;
          if (
            typeof doc.pageTitle === "string" &&
            typeof doc.pageId === "string" &&
            typeof doc.pageUrl === "string" &&
            typeof doc.similarity === "number" &&
            typeof doc.content === "string"
          ) {
            // 处理文档
            toolSources.push({
              title: doc.pageTitle,
              notionPageId: doc.pageId,
              pageUrl: doc.pageUrl,
              similarity: doc.similarity,
              excerpt: doc.content.substring(0, 100),
            });
          }
        }
      }
    }
    if (
      toolUse.name === "web_search" &&
      toolResult.ok &&
      toolResult.data &&
      typeof toolResult.data === "object"
    ) {
      const search = toolResult.data as WebSearchContent;
      const results = search.response?.results;
      if (Array.isArray(results)) {
        for (const result of results) {
          const pageUrl = typeof result.url === "string" ? result.url : "";
          if (!pageUrl) continue;

          const title =
            typeof result.title === "string" && result.title.trim()
              ? result.title
              : pageUrl;
          const excerpt =
            typeof result.content === "string" ? result.content.substring(0, 180) : "";
          const similarity =
            typeof result.score === "number" && Number.isFinite(result.score)
              ? result.score
              : 1;

          toolSources.push({
            title,
            notionPageId: pageUrl,
            pageUrl,
            similarity,
            excerpt,
          });
        }
      }
    }
    if (
      toolUse.name === "web_fetch" &&
      toolResult.ok &&
      toolResult.data &&
      typeof toolResult.data === "object"
    ) {
      const page = toolResult.data as WebFetchContent;
      const pageUrl =
        typeof page.finalUrl === "string"
          ? page.finalUrl
          : typeof page.url === "string"
            ? page.url
            : "";
      if (pageUrl) {
        const title =
          typeof page.title === "string" && page.title.trim()
            ? page.title
            : pageUrl;
        const excerpt =
          typeof page.snippet === "string" && page.snippet.trim()
            ? page.snippet
            : typeof page.text === "string"
              ? page.text.substring(0, 180)
              : "";
        toolSources.push({
          title,
          notionPageId: pageUrl,
          pageUrl,
          similarity: 1,
          excerpt,
        });
      }
    }
    const truncated = shapeToolResultContent(toolUse.name, toolResult);
    const artifactResult = await maybeStoreToolArtifact({
      toolUse,
      toolResult,
      shapedResult: truncated,
      scopeId,
      userId,
      requestId,
    });
    const modelContent = artifactResult?.modelContent ?? truncated.content;
    const rawPreview = truncateToolContent(toolResult.content, 1_200);
    toolResultBlocks.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: modelContent,
      is_error: !toolResult.ok,
    });
    if (toolResult.metadata?.status !== "duplicate_skipped") {
      // 不再拼 marker 字符串，直接造结构化事件 payload（前端按 type 分发，不靠分隔符切割）
      toolCalls.push({
        name: toolUse.name,
        input: toolUse.input,
        id: toolUse.id,
        ok: toolResult.ok,
        content: modelContent,
        truncated: truncated.truncated,
        originalChars: truncated.originalChars,
        error: toolResult.error,
        metadata: {
          ...toolResult.metadata,
          capabilities: toolDefinition?.capabilities,
          grounding: toolDefinition?.outputPolicy.grounding,
          citationRequired: toolDefinition?.outputPolicy.citationRequired,
          artifactId: artifactResult?.artifact.id,
          artifactStored: Boolean(artifactResult),
          modelContentCompressed: truncated.content !== rawPreview.content,
          rawContentPreview: rawPreview.content,
          rawContentTruncated: rawPreview.truncated,
          rawContentOriginalChars: rawPreview.originalChars,
        },
      });
    }
    toolSteps.push({
      type: "tool",
      index: 0,
      startedAt: Date.now(),
      durationMs,
      name: toolUse.name,
      input: toolUse.input,
      ok: toolResult.ok,
      toolCallId: toolUse.id,
      contentSummary: modelContent,
      contentTruncated: truncated.truncated,
      contentOriginalChars: truncated.originalChars,
      rawContentSummary: rawPreview.content,
      rawContentTruncated: rawPreview.truncated,
      rawContentOriginalChars: rawPreview.originalChars,
      error: toolResult.error,
      metadata: {
        ...toolResult.metadata,
        capabilities: toolDefinition?.capabilities,
        grounding: toolDefinition?.outputPolicy.grounding,
        citationRequired: toolDefinition?.outputPolicy.citationRequired,
        artifactId: artifactResult?.artifact.id,
        artifactStored: Boolean(artifactResult),
      },
      costPerUse,
    });
  }
  return {
    toolResultBlocks,
    toolSources,
    toolCalls,
    toolMetrics,
    toolSteps,
    evidenceBundles,
    usedGroundingModes: Array.from(usedGroundingModes),
    toolEvidenceRequired,
    usedCapabilities: Array.from(usedCapabilities),
  };
}

async function executeToolUsesWithScheduler(
  toolUses: ToolUseBlock[],
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
  requestId?: string,
  conversationContext?: string[],
  signal?: AbortSignal,
) {
  type ScheduledToolUse = {
    index: number;
    toolUse: ToolUseBlock;
    tool: ReturnType<ToolRegistry["get"]>;
  };
  const results: Array<{
    index: number;
    toolUse: ToolUseBlock;
    toolResult: Awaited<ReturnType<typeof executeToolCall>>;
  }> = [];

  const scheduled: ScheduledToolUse[] = toolUses.map((toolUse, index) => ({
    index,
    toolUse,
    tool: toolRegistry.get(toolUse.name),
  }));

  const parallelByGroup = new Map<
    string,
    ScheduledToolUse[]
  >();
  const serial: ScheduledToolUse[] = [];

  for (const item of scheduled) {
    const runtime = item.tool?.runtime;
    const sideEffect = runtime?.sideEffect ?? "read";
    const mustRunSerial =
      !item.tool ||
      item.tool.riskLevel !== "safe" ||
      runtime?.dangerous === true ||
      runtime?.requiresConfirmation === true ||
      sideEffect === "write";

    if (mustRunSerial) {
      serial.push(item);
      continue;
    }

    const group = runtime?.concurrencyGroup ?? item.toolUse.name;
    const items = parallelByGroup.get(group) ?? [];
    items.push(item);
    parallelByGroup.set(group, items);
  }

  for (const [group, items] of Array.from(parallelByGroup.entries())) {
    const maxConcurrency = Math.max(
      1,
      Math.min(
        ...items.map((item) => item.tool?.runtime.maxConcurrency ?? 4),
      ),
    );
    for (let i = 0; i < items.length; i += maxConcurrency) {
      const batch = items.slice(i, i + maxConcurrency);
      results.push(
        ...(await Promise.all(
          batch.map(async (item) => ({
            index: item.index,
            toolUse: item.toolUse,
            toolResult: await executeSingleToolUse(
              item.toolUse,
              toolRegistry,
              scopeId,
              userId,
              requestId,
              conversationContext,
              signal,
            ),
          })),
        )),
      );
    }
  }

  for (const item of serial) {
    results.push({
      index: item.index,
      toolUse: item.toolUse,
      toolResult: await executeSingleToolUse(
        item.toolUse,
        toolRegistry,
        scopeId,
        userId,
        requestId,
        conversationContext,
        signal,
      ),
    });
  }

  return results.sort((a, b) => a.index - b.index);
}

function executeSingleToolUse(
  toolUse: ToolUseBlock,
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
  requestId?: string,
  conversationContext?: string[],
  signal?: AbortSignal,
) {
  return executeToolCall(
    toolRegistry,
    {
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
    },
    { scopeId, userId, requestId, conversationContext, signal },
  );
}

function extractMessageText(message: ModelMessage) {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function buildToolConversationContext(messages: ModelMessage[]) {
  const conversationalMessages = messages
    .map((message) => ({ role: message.role, text: extractMessageText(message) }))
    .filter((message) => message.text.length > 0);
  const currentUserIndex = conversationalMessages.findLastIndex(
    (message) => message.role === "user",
  );
  const previousMessages = currentUserIndex >= 0
    ? conversationalMessages.slice(0, currentUserIndex)
    : conversationalMessages;

  return previousMessages.slice(-4).map((message) => message.text);
}

function dedupeSources(sources: ToolSourceType[], limit = 8) {
  const byKey = new Map<string, ToolSourceType>();

  for (const source of sources) {
    const key = source.pageUrl || source.notionPageId || source.title;
    const current = byKey.get(key);

    if (!current || source.similarity > current.similarity) {
      byKey.set(key, source);
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export const enqueueSources = (sources: ToolSourceType[], enqueueText: (text: string) => boolean) => {
  const uniqueSources = dedupeSources(sources);
  if (uniqueSources.length === 0) return;
  // 整批来源一次性发一个 sources 事件（替代 __SOURCES__ marker）
  enqueueEvent({ type: "sources", sources: uniqueSources }, enqueueText);
};

export async function runAgentLoop(
  loopMessages: ModelMessage[],
  tools: Anthropic.Tool[],
  toolRegistry: ToolRegistry,
  maxToolIterations: number,
  allToolSources: ToolSourceType[],
  enqueueText: (text: string) => boolean,
  requestId: string = "",
  sessionId?: string,
  deps: { callModel: typeof callModel } = { callModel },
  system?: string, // 召回的记忆，透传给每轮 callModel 作为 system 注入
  shouldStop: () => boolean = () => false,
  model: ChatModelId = defaultChatModel,
  // system 对应的段化结构，仅用于写进 trace 供详情页按段展示；不影响实际注入（注入仍用 system 字符串）
  systemSegments?: Array<{
    kind: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>,
  userId?: string,
  retrievalPlan?: RetrievalPlan,
  initialEvidenceBundles: EvidenceBundle[] = [],
  contextPlan?: ContextPlan,
  initialSatisfiedCapabilities: Iterable<string> = [],
  onReasoning?: (reasoning: import("@/lib/agent/runtime/events").ReasoningEventData) => void,
  initialRetrievalToolCalls: ReadonlyMap<string, number> = new Map(),
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  // 防重复工具调用
  const seenToolCalls = new Set<string>();
  const tokenBudget = new TokenBudget(AGENT_LOOP_TOKEN_BUDGET);
  const trace = createTrace(requestId, sessionId);
  trace.contextPlan = contextPlan;
  let stepIndex = 0; // model/tool step 共享的全局递增序号
  const evidenceBundles: EvidenceBundle[] = [...initialEvidenceBundles];
  const usedGroundingModes = new Set<ToolGroundingMode>();
  const satisfiedCapabilities = new Set(initialSatisfiedCapabilities);
  let toolEvidenceRequired = mergeEvidenceBundles(initialEvidenceBundles).length > 0;
  if (mergeEvidenceBundles(initialEvidenceBundles).length > 0) {
    usedGroundingModes.add("cited_evidence");
  }
  const retrievalToolCalls = new Map(initialRetrievalToolCalls);
  if (retrievalPlan) {
    trace.steps.push({
      type: "retrieval",
      phase: "routed",
      index: stepIndex++,
      startedAt: Date.now(),
      planId: retrievalPlan.id,
      route: retrievalPlan.route,
      reason: retrievalPlan.reason,
      confidence: retrievalPlan.confidence,
      freshnessRequired: retrievalPlan.freshnessRequired,
      evidenceRequired: retrievalPlan.evidenceRequired,
      maxAttempts: retrievalPlan.maxAttempts,
      indexVersion: retrievalPlan.indexVersion,
      query: retrievalPlan.standaloneQuery,
    });
  }
  let lastCompactedMessageCount: number | undefined;
  const metrics: AgentLoopMetrics = {
    estimatedTokensSpent: 0,
    modelCallCount: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    actualTotalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    estimatedModelCostCny: 0,
    toolCallCount: 0,
    totalToolCost: 0,
    toolDurations: [],
  };
  // 在每个 return 出口前调用，把 trace 的总览字段回填成真实值
  const finalizeTrace = (
    stopReason: AgentLoopStopReason,
    completed: boolean,
  ) => {
    trace.stopReason = stopReason;
    trace.completed = completed;
    trace.endedAt = Date.now();
    trace.totalDurationMs = trace.endedAt - trace.startedAt;
    trace.metrics = metrics;
    return trace;
  };
  const compactWithObservation = async (force = false) => {
    const messageCount = loopMessages.length;
    const runCompaction = () => compactLoopMessagesSemantic(loopMessages, {
      modelWindowTokens: Math.min(
        getModelContextWindowTokens(model),
        CONTEXT_COMPACTION_WINDOW_CAP,
      ),
      triggerRatio: CONTEXT_COMPACTION_TRIGGER_RATIO,
      targetRatio: CONTEXT_COMPACTION_TARGET_RATIO,
      primerMessages: 3,
      recentMessages: 6,
      minNewMessagesSinceLastCompression: 8,
      lastCompactedMessageCount,
      force,
      compressionModel: model,
      compressor: (input) =>
        callCompressionModel({
          ...input,
          signal,
          model,
          telemetryMetadata: {
            operation: force ? "context-compaction-budget-guard" : "context-compaction",
            requestId,
            sessionId,
            userId,
            messageCount,
          },
        }),
    });
    if (!getActiveTraceId()) return runCompaction();

    return startActiveObservation("context.compaction", async (observation) => {
      const result = await runCompaction();
      observation.update({
        metadata: withSpanLabel("context.compaction", { requestId, sessionId }),
        input: { messageCount, force },
        output: {
          compacted: result.compacted,
          skippedReason: result.skippedReason,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          tokenReduction: result.beforeTokens - result.afterTokens,
          method: result.method,
          fallbackReason: result.fallbackReason,
        },
      });
      return result;
    });
  };

  for (let i = 0; i < maxToolIterations; i++) {
    signal?.throwIfAborted();
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "aborted",
        metrics,
        trace: finalizeTrace("aborted", false),
      };
    }
    const compactionStartedAt = Date.now();
    const runtimeContextWindowTokens = Math.min(
      getModelContextWindowTokens(model),
      CONTEXT_COMPACTION_WINDOW_CAP,
    );
    const compacted = await compactWithObservation();
    signal?.throwIfAborted();
    loopMessages = compacted.messages;
    if (compacted.compacted) {
      lastCompactedMessageCount = loopMessages.length;
      const compactionStep: ContextCompactionTraceStep = {
        type: "context_compaction",
        index: stepIndex++,
        startedAt: compactionStartedAt,
        durationMs: Date.now() - compactionStartedAt,
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        modelWindowTokens: compacted.modelWindowTokens,
        triggerTokens: compacted.triggerTokens,
        targetTokens: compacted.targetTokens,
        primerMessages: compacted.primerMessages,
        recentMessages: compacted.recentMessages,
        middleMessageCount: compacted.middleMessageCount,
        reason: compacted.reason ?? "compacted",
        summary: compacted.summary ?? "",
        summaryChars: compacted.summary?.length ?? 0,
        method: compacted.method,
        compressionModel: compacted.compressionModel,
        fallbackReason: compacted.fallbackReason,
      };
      trace.steps.push(compactionStep);
    }
    // 预算不够时，先做一次不受常规频率限制的强制压缩，再决定是否停止工具循环。
    let estimatedContextTokens = estimateModelRequestTokens({
      messages: loopMessages,
      system,
      tools,
    });
    if (!tokenBudget.canAfford(estimatedContextTokens + AGENT_LOOP_OUTPUT_RESERVE)) {
      const forcedCompactionStartedAt = Date.now();
      const forcedCompaction = await compactWithObservation(true);
      loopMessages = forcedCompaction.messages;
      if (forcedCompaction.compacted) {
        lastCompactedMessageCount = loopMessages.length;
        trace.steps.push({
          type: "context_compaction",
          index: stepIndex++,
          startedAt: forcedCompactionStartedAt,
          durationMs: Date.now() - forcedCompactionStartedAt,
          beforeTokens: forcedCompaction.beforeTokens,
          afterTokens: forcedCompaction.afterTokens,
          modelWindowTokens: forcedCompaction.modelWindowTokens,
          triggerTokens: forcedCompaction.triggerTokens,
          targetTokens: forcedCompaction.targetTokens,
          primerMessages: forcedCompaction.primerMessages,
          recentMessages: forcedCompaction.recentMessages,
          middleMessageCount: forcedCompaction.middleMessageCount,
          reason: `budget_guard:${forcedCompaction.reason ?? "compacted"}`,
          summary: forcedCompaction.summary ?? "",
          summaryChars: forcedCompaction.summary?.length ?? 0,
          method: forcedCompaction.method,
          compressionModel: forcedCompaction.compressionModel,
          fallbackReason: forcedCompaction.fallbackReason,
        });
        estimatedContextTokens = estimateModelRequestTokens({
          messages: loopMessages,
          system,
          tools,
        });
      }
    }

    const tokenBudgetSnapshot = {
      max: tokenBudget.max,
      spentBefore: tokenBudget.spent,
      remainingBefore: tokenBudget.remaining(),
      requested: estimatedContextTokens,
      reservedOutputTokens: AGENT_LOOP_OUTPUT_RESERVE,
    };
    const contextBreakdown = buildContextUsageBreakdown({
      messages: loopMessages,
      system,
      tools,
      systemSegments,
      totalTokens: estimatedContextTokens,
    });
    const contextUsageEvent = (
      phase: "before_model" | "after_model" | "blocked",
      spentTokens: number,
    ) => ({
      type: "context_usage" as const,
      usage: {
        model,
        modelCallIndex: metrics.modelCallCount + (phase === "after_model" ? 0 : 1),
        estimatedTokens: estimatedContextTokens,
        workingWindowTokens: runtimeContextWindowTokens,
        modelWindowTokens: getModelContextWindowTokens(model),
        remainingTokens: Math.max(0, runtimeContextWindowTokens - estimatedContextTokens),
        phase,
        breakdown: contextBreakdown,
        runBudget: {
          spentTokens,
          maxTokens: tokenBudget.max,
          remainingTokens: Math.max(0, tokenBudget.max - spentTokens),
          nextRequestTokens: estimatedContextTokens,
          outputReserveTokens: AGENT_LOOP_OUTPUT_RESERVE,
          requiredTokens: estimatedContextTokens + AGENT_LOOP_OUTPUT_RESERVE,
          canContinue:
            tokenBudget.max - spentTokens
            >= estimatedContextTokens + AGENT_LOOP_OUTPUT_RESERVE,
        },
      },
    });
    const canContinue = tokenBudget.canAfford(
      estimatedContextTokens + AGENT_LOOP_OUTPUT_RESERVE,
    );
    enqueueEvent(
      contextUsageEvent(canContinue ? "before_model" : "blocked", tokenBudget.spent),
      enqueueText,
    );
    if (!canContinue) {
      enqueueEvent(
        {
          type: "text",
          content:
            "\n\n本轮 Agent 的 token 预算已接近上限，且压缩后仍不足以继续调用工具。我会基于当前已有信息回答。\n\n",
        },
        enqueueText,
      );
      return {
        loopMessages,
        completed: false,
        stopReason: "token_budget_exceeded",
        metrics,
        trace: finalizeTrace("token_budget_exceeded", false),
      };
    }
    metrics.modelCallCount += 1;
    const modelStartedAt = Date.now();
    // 把 enqueueText 包成 onTextDelta 回调传入，text delta 逐 token 推给前端
    const evidenceRequired = requiresCitedEvidence({
      sourceEvidenceRequired: retrievalPlan?.evidenceRequired,
      toolEvidenceRequired,
    });
    // 校验只负责生成 Trace/Eval 指标，不参与输出决策。无论 evidenceRequired
    // 或最终 status 是什么，模型文本都按原始流发送，不缓冲、不替换、不追加提示。
    const shouldVerifyEvidence = evidenceRequired
      || mergeEvidenceBundles(evidenceBundles).length > 0;
    const onTextDelta = (text: string) =>
      enqueueEvent({ type: "text", content: text }, enqueueText);
    const onReasoningDelta = (text: string) => {
      const reasoning = {
        id: `${requestId || "agent-loop"}:${metrics.modelCallCount}`,
        modelCallIndex: metrics.modelCallCount,
        content: text,
      };
      enqueueEvent({
        type: "reasoning",
        reasoning,
      }, enqueueText);
      onReasoning?.(reasoning);
    };
    const loopTelemetry = buildAgentLoopTelemetry({
      messages: loopMessages,
    });
    let initialResponse = await deps.callModel(
      loopMessages,
      tools,
      system,
      onTextDelta,
      onReasoningDelta,
      model,
      {
        operation: "agent-loop",
        requestId,
        sessionId,
        userId,
        modelCallIndex: metrics.modelCallCount,
        loopTrigger: loopTelemetry.trigger,
        triggeringTools: loopTelemetry.triggeringTools,
      },
      loopTelemetry.functionId,
      signal,
    );
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "aborted",
        metrics,
        trace: finalizeTrace("aborted", false),
      };
    }
    const toolUses = extractToolUses(initialResponse.content);
    const directText = extractText(initialResponse.content);
    const textSummary = summarizeText(directText);
    const rawUsage = initialResponse.usage as
      | (Anthropic.Message["usage"] & {
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        })
      | undefined;
    const modelUsage: ModelUsageBreakdown | undefined = rawUsage
      ? calculateModelUsageCost(model, {
          inputTokens: rawUsage.input_tokens,
          outputTokens: rawUsage.output_tokens,
          cacheHitTokens:
            rawUsage.prompt_cache_hit_tokens ??
            rawUsage.cache_read_input_tokens ??
            undefined,
          cacheMissTokens: rawUsage.prompt_cache_miss_tokens,
          cacheCreationTokens: rawUsage.cache_creation_input_tokens ?? undefined,
        }, initialResponse.pricing)
      : undefined;
    if (modelUsage) {
      metrics.actualInputTokens += modelUsage.inputTokens;
      metrics.actualOutputTokens += modelUsage.outputTokens;
      metrics.actualTotalTokens += modelUsage.totalTokens;
      metrics.cacheHitTokens += modelUsage.cacheHitTokens;
      metrics.cacheMissTokens += modelUsage.cacheMissTokens;
      metrics.estimatedModelCostCny += modelUsage.estimatedCostCny;
      enqueueEvent(
        {
          type: "model_usage",
          usage: {
            model,
            modelCallIndex: metrics.modelCallCount,
            ...modelUsage,
          },
        },
        enqueueText,
      );
    }
    const budgetChargeTokens = modelUsage?.totalTokens ?? estimatedContextTokens;
    tokenBudget.spend(budgetChargeTokens);
    enqueueEvent(contextUsageEvent("after_model", tokenBudget.spent), enqueueText);
    const tokenBudgetAfterSpend = {
      spentAfter: tokenBudget.spent,
      remainingAfter: tokenBudget.remaining(),
    };
    metrics.estimatedTokensSpent = tokenBudget.spent;
    // 记录本轮注入的 system prompt（截断后），供 trace 详情页展示「喂了什么上下文」
    const systemSummary = system ? summarizeText(system) : undefined;
    const modelStep: ModelTraceStep = {
      type: "model",
      model,
      modelName: initialResponse.modelName,
      providerName: initialResponse.providerName,
      providerModelId: initialResponse.providerModelId,
      pricingSnapshot: modelUsage?.pricing,
      index: stepIndex++,
      startedAt: modelStartedAt,
      durationMs: Date.now() - modelStartedAt,
      textSummary: textSummary.content,
      textTruncated: textSummary.truncated,
      textOriginalChars: textSummary.originalChars,
      systemPrompt: systemSummary?.content,
      systemPromptTruncated: systemSummary?.truncated,
      systemPromptOriginalChars: systemSummary?.originalChars,
      systemSegments,
      contextPlanId: contextPlan?.id,
      requestedToolCalls: toolUses.map((t: ToolUseBlock) => ({
        name: t.name,
        id: t.id,
        input: t.input,
      })),
      estimatedContextTokens,
      tokenBudget: {
        ...tokenBudgetSnapshot,
        ...tokenBudgetAfterSpend,
      },
      usage: modelUsage,
    };
    trace.steps.push(modelStep);
    if (initialResponse.stop_reason === "max_tokens") {
      enqueueEvent(
        {
          type: "text",
          content:
            "\n\n（输出达到模型单次回复上限，内容可能未完整生成。）",
        },
        enqueueText,
      );
      return {
        loopMessages,
        completed: false,
        stopReason: "max_tokens",
        metrics,
        trace: finalizeTrace("max_tokens", false),
      };
    }
    if (toolUses.length === 0) {
      const finalText = directText;
      if (shouldVerifyEvidence) {
        const validationStartedAt = Date.now();
        const report = verifyGroundedAnswer(finalText, evidenceBundles, { evidenceRequired });
        trace.steps.push({
          type: "answer_validation",
          index: stepIndex++,
          startedAt: validationStartedAt,
          durationMs: Date.now() - validationStartedAt,
          report,
          // 校验结果仅上报；输出策略明确禁止据此修改模型回答。
          guarded: false,
        });
      }
      if (allToolSources.length > 0) {
        enqueueSources(allToolSources, enqueueText);
      }
      loopMessages = [
        ...loopMessages,
        {
          role: "assistant" as const,
          content: initialResponse.content,
          ...(initialResponse.reasoning_content
            ? { reasoning_content: initialResponse.reasoning_content }
            : {}),
        } as DeepSeekAssistantMessage,
      ];
      return {
        loopMessages,
        completed: true,
        stopReason: "completed",
        metrics,
        trace: finalizeTrace("completed", true),
        evidenceBundles,
        usedGroundingModes: Array.from(usedGroundingModes),
        toolEvidenceRequired,
        usedCapabilities: Array.from(satisfiedCapabilities),
      };
    }
    // 依赖缺失和预算跳过都表现为“有结构化 tool_result，但不执行工具”。
    // 统一放进 precomputedResults，后面的 executeTools 仍能按原调用顺序把结果
    // 回灌给模型，同时避免这些未执行调用污染 grounding/capability 统计。
    const precomputedResults = new Map<
      string,
      Awaited<ReturnType<typeof executeToolCall>>
    >();
    for (const toolUse of toolUses) {
      const tool = toolRegistry.get(toolUse.name);
      if (!tool) continue;
      // prerequisites 按“上一轮已成功完成的 capability”判断。即使模型在同一批
      // 同时请求 time 和 web，也必须先阻止 web；只有时间结果已经返回给模型后，
      // 下一轮的 web 调用才允许执行，保证依赖确实是有序而非仅仅同时出现。
      const missingCapabilities = missingToolPrerequisites(
        tool,
        satisfiedCapabilities,
        retrievalPlan,
      );
      if (missingCapabilities.length === 0) continue;
      precomputedResults.set(toolUse.id, {
        ok: false,
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        content: `调用 ${toolUse.name} 前缺少前置能力：${missingCapabilities.join(", ")}。请先调用具备这些能力的工具，并等待结果。`,
        error: "Tool orchestration prerequisites are not satisfied",
        metadata: {
          status: "orchestration_prerequisite_missing",
          missingCapabilities,
        },
      });
    }
    for (const toolUse of toolUses) {
      if (precomputedResults.has(toolUse.id)) continue;
      const retrievalPolicy = toolRegistry.get(toolUse.name)?.outputPolicy.retrieval;
      if (!retrievalPolicy) continue;
      // 编排拦截发生在预算计数之前。缺少 prerequisite 的调用从未执行，不能提前
      // 消耗检索额度，否则模型补齐依赖后会被误判为已经用完预算。
      const used = retrievalToolCalls.get(toolUse.name) ?? 0;
      const limit = retrievalPolicy.maxCallsPerRun;
      if (used >= limit) {
        precomputedResults.set(toolUse.id, {
          ok: true,
          toolName: toolUse.name,
          toolCallId: toolUse.id,
          content: `${toolUse.name} 已达到本轮检索预算 ${limit} 次，本次调用已跳过；请使用已有证据继续回答。`,
          metadata: {
            status: "retrieval_budget_skipped",
            retrievalBudget: limit,
          },
        });
        continue;
      }
      retrievalToolCalls.set(toolUse.name, used + 1);
    }
    const executableToolUses = toolUses.filter((toolUse) =>
      !precomputedResults.has(toolUse.id));
    const toolCallKeys = executableToolUses.map(getToolCallKey);
    const hasRepeatedToolCall = toolCallKeys.some((key) =>
      seenToolCalls.has(key),
    );
    // 用户问题重复 ≠ 工具调用重复。重复保护防的是模型 loop 卡住，不是防用户输入重复
    if (hasRepeatedToolCall) {
      enqueueEvent(
        {
          type: "text",
          content:
            "\n\n检测到重复工具调用，已停止继续执行工具。我会基于已有结果回答。\n\n",
        },
        enqueueText,
      );
      return {
        loopMessages,
        completed: false,
        stopReason: "repeated_tool_call",
        metrics,
        trace: finalizeTrace("repeated_tool_call", false),
      };
    }
    for (const key of toolCallKeys) {
      seenToolCalls.add(key);
    }
    // 给模型用，作为 Anthropic tool_result 消息
    const {
      toolResultBlocks,
      toolSources,
      toolCalls,
      toolMetrics,
      toolSteps,
      evidenceBundles: newEvidenceBundles,
      usedGroundingModes: newGroundingModes,
      toolEvidenceRequired: newToolEvidenceRequired,
      usedCapabilities: newCapabilities,
    } = await executeTools(
      toolUses,
      toolRegistry,
      sessionId ?? requestId,
      userId,
      requestId,
      buildToolConversationContext(loopMessages),
      precomputedResults,
      signal,
    );
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "aborted",
        metrics,
        trace: finalizeTrace("aborted", false),
      };
    }
    metrics.toolCallCount += toolMetrics.length;
    metrics.totalToolCost += toolMetrics.reduce(
      (sum, item) => sum + item.costPerUse,
      0,
    );
    metrics.toolDurations.push(
      ...toolMetrics.map((item) => ({
        name: item.name,
        durationMs: item.durationMs,
      })),
    );
    for (const step of toolSteps) {
      step.index = stepIndex++;
      trace.steps.push(step);
    }
    evidenceBundles.push(...newEvidenceBundles);
    for (const mode of newGroundingModes) usedGroundingModes.add(mode);
    toolEvidenceRequired ||= newToolEvidenceRequired;
    // 只合并 executeTools 从 ok=true 的真实执行中提取出的 capability；依赖缺失、
    // 重复跳过和预算跳过都不能声明已满足 prerequisite。
    for (const capability of newCapabilities) satisfiedCapabilities.add(capability);
    for (const bundle of newEvidenceBundles) {
      const thresholds = bundle.attempts.flatMap((attempt) =>
        typeof attempt.threshold === "number" ? [attempt.threshold] : []);
      const thresholdFallback = thresholds.slice(1).some(
        (threshold) => threshold < thresholds[0],
      );
      const timings = bundle.attempts.reduce<Record<string, number>>(
        (total, attempt) => {
          for (const [phase, duration] of Object.entries(attempt.timings ?? {})) {
            if (Number.isFinite(duration)) total[phase] = (total[phase] ?? 0) + duration;
          }
          return total;
        },
        {},
      );
      const retrievalStep: RetrievalTraceStep = {
        type: "retrieval",
        phase: "graded",
        index: stepIndex++,
        startedAt: Date.now(),
        toolName: bundle.toolName,
        planId: bundle.planId ?? retrievalPlan?.id ?? "unplanned",
        route: bundle.route,
        reason: bundle.grade.reason,
        evidenceRequired: retrievalPlan?.evidenceRequired,
        maxAttempts: retrievalPlan?.maxAttempts ?? 2,
        indexVersion: bundle.indexVersion,
        source: bundle.evidences[0]?.source ?? bundle.attempts[0]?.source,
        query: bundle.query,
        filters: retrievalPlan?.steps.find(
          (step) => step.source === (bundle.attempts[0]?.source ?? bundle.evidences[0]?.source),
        )?.filters,
        evidenceCount: bundle.evidences.length,
        grade: bundle.grade,
        cacheHits: bundle.attempts.filter((attempt) => attempt.cacheHit).length,
        queryAttempts: bundle.attempts.length,
        thresholdFallback,
        scoreGap: bundle.grade.scoreGap,
        degradationReason: bundle.grade.sufficient ? undefined : bundle.grade.reason,
        attempts: bundle.attempts,
        timings,
        durationMs: timings.totalMs,
      };
      trace.steps.push(retrievalStep);
    }
    // 每个工具调用发一个 tool_call 事件（替代旧的 __TOOL_CALL__ marker 字符串）
    for (const tc of toolCalls) {
      enqueueEvent({ type: "tool_call", toolCall: tc }, enqueueText);
    }
    allToolSources.push(...toolSources);
    loopMessages = appendToolResults(
      loopMessages,
      initialResponse,
      toolResultBlocks,
    );
    const pendingConfirmation = toolCalls.find(
      (toolCall) => toolCall.metadata?.status === "pending_confirmation",
    );
    if (pendingConfirmation) {
      return {
        loopMessages,
        completed: true,
        stopReason: "awaiting_tool_confirmation",
        metrics,
        trace: finalizeTrace("awaiting_tool_confirmation", true),
        usedGroundingModes: Array.from(usedGroundingModes),
        toolEvidenceRequired,
        usedCapabilities: Array.from(satisfiedCapabilities),
      };
    }
    const userQuestion = toolCalls.find(
      (toolCall) => toolCall.metadata?.status === "awaiting_user_input",
    );
    if (userQuestion) {
      const question =
        typeof userQuestion.metadata?.question === "string"
          ? userQuestion.metadata.question
          : userQuestion.content;
      enqueueEvent({ type: "text", content: `${question}\n` }, enqueueText);
      loopMessages = [
        ...loopMessages,
        { role: "assistant" as const, content: question },
      ];
      return {
        loopMessages,
        completed: true,
        stopReason: "awaiting_user_input",
        metrics,
        trace: finalizeTrace("awaiting_user_input", true),
        usedGroundingModes: Array.from(usedGroundingModes),
        toolEvidenceRequired,
        usedCapabilities: Array.from(satisfiedCapabilities),
      };
    }
  }
  return {
    loopMessages,
    completed: false,
    stopReason: "max_iterations",
    metrics,
    trace: finalizeTrace("max_iterations", false),
    evidenceBundles,
    usedGroundingModes: Array.from(usedGroundingModes),
    toolEvidenceRequired,
    usedCapabilities: Array.from(satisfiedCapabilities),
  };
}

export async function streamModelResponse(
  messages: ModelMessage[],
  system?: string,
  model: ChatModelId = defaultChatModel,
  telemetryMetadata?: ModelTelemetryMetadata,
  onReasoningDelta?: (text: string) => void,
  signal?: AbortSignal,
) {
  return streamTextWithProvider({
    model,
    messages,
    system,
    telemetryMetadata,
    onReasoningDelta,
    signal,
  });
}

export async function forwardTextStream(
  stream: Awaited<ReturnType<typeof streamTextWithProvider>>,
  enqueueText: (text: string) => boolean,
  shouldStop: () => boolean,
): Promise<Anthropic.Messages.StopReason | undefined> {
  for await (const text of stream.textStream) {
    if (shouldStop()) {
      break;
    }

    const sanitizedText = sanitizeModelText(text);
    if (sanitizedText && !enqueueText(sanitizedText)) {
      break;
    }
  }

  const finishReason = await stream.finishReason;
  return finishReason === "length" ? "max_tokens" : "end_turn";
}
