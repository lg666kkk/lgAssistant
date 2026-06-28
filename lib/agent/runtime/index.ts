import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import {
  TokenBudget,
  estimateTokens,
  truncateToolContent,
} from "@/lib/agent/runtime/budget";
import {
  compactLoopMessagesSemantic,
} from "@/lib/agent/runtime/compaction";
import { createTrace, summarizeText } from "@/lib/agent/runtime/trace";
import { enqueueEvent } from "@/lib/agent/runtime/events";
import type { ToolCallEventData } from "@/lib/agent/runtime/events";
import {
  callModelWithProvider,
  generateTextWithProvider,
  streamTextWithProvider,
} from "@/lib/agent/runtime/model-provider";
import {
  calculateModelUsageCost,
  defaultChatModel,
  getModelContextWindowTokens,
  type ChatModelId,
  type ModelUsageBreakdown,
} from "@/lib/agent/models";
import Anthropic from "@anthropic-ai/sdk";

// Anthropic SDK 真实类型——替代原来的 any，编译器现在能帮你检查每个字段
type ModelMessage = Anthropic.MessageParam;
type ModelContentBlock = Anthropic.Messages.ContentBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

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
  ToolTraceStep,
} from "@/lib/agent/runtime/trace";

export type AgentLoopStopReason =
  | "completed"
  | "max_tokens"
  | "token_budget_exceeded"
  | "repeated_tool_call"
  | "max_iterations";

type AgentLoopResult = {
  loopMessages: ModelMessage[];
  completed: boolean;
  stopReason: AgentLoopStopReason;
  metrics: AgentLoopMetrics;
  trace: AgentTrace;
};

export interface ToolSourceType {
  title: string;
  notionPageId: string;
  pageUrl: string;
  similarity: number;
  excerpt: string;
}

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
  assistantResponse: Anthropic.Message,
  toolResultBlocks: ToolResultBlock[],
): ModelMessage[] {
  return [
    ...loopMessages,
    // role 必须是字面量类型 "assistant" | "user"，不能是宽泛的 string
    { role: "assistant" as const, content: assistantResponse.content },
    { role: "user" as const, content: toolResultBlocks },
  ];
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

function shapeSearchNotesContent(toolResult: Awaited<ReturnType<typeof executeToolCall>>) {
  if (
    !toolResult.ok ||
    !toolResult.data ||
    typeof toolResult.data !== "object" ||
    !("results" in toolResult.data)
  ) {
    return undefined;
  }

  const results = toolResult.data.results;
  if (!Array.isArray(results) || results.length === 0) return undefined;

  return [
    "search_notes 结果（已压缩给模型使用）",
    ...results.slice(0, 8).map((result, index) => {
      const doc = result as DocContent;
      const title = typeof doc.pageTitle === "string" ? doc.pageTitle : "(无标题)";
      const url = typeof doc.pageUrl === "string" ? doc.pageUrl : "";
      const headingPath = Array.isArray(doc.headingPath)
        ? doc.headingPath.filter((v): v is string => typeof v === "string")
        : [];
      const similarity =
        typeof doc.similarity === "number" ? `相似度：${doc.similarity.toFixed(3)}` : undefined;
      const scores = [
        typeof doc.vectorScore === "number" ? `向量：${doc.vectorScore.toFixed(3)}` : undefined,
        typeof doc.keywordScore === "number" ? `关键词：${doc.keywordScore.toFixed(3)}` : undefined,
        typeof doc.rerankScore === "number" ? `精排：${doc.rerankScore.toFixed(3)}` : undefined,
      ].filter(Boolean).join(" / ");
      const content = typeof doc.content === "string" ? compactTextPrefix(doc.content, 700) : "";
      return [
        `${index + 1}. ${title}`,
        headingPath.length > 0 ? `位置：${headingPath.join(" / ")}` : undefined,
        url ? `链接：${url}` : undefined,
        similarity,
        scores ? `分数：${scores}` : undefined,
        content ? `摘录：${content}` : undefined,
      ]
        .filter((item) => item !== undefined)
        .join("\n");
    }),
  ].join("\n\n");
}

function shapeToolResultContent(
  toolName: string,
  toolResult: Awaited<ReturnType<typeof executeToolCall>>,
) {
  const shaped =
    toolName === "web_fetch"
      ? shapeWebFetchContent(toolResult)
      : toolName === "web_search"
        ? shapeWebSearchContent(toolResult)
        : toolName === "search_notes"
          ? shapeSearchNotesContent(toolResult)
          : undefined;

  return truncateToolContent(shaped ?? toolResult.content, 1_200);
}

const AGENT_LOOP_TOKEN_BUDGET = 24_000;
const CONTEXT_COMPACTION_WINDOW_CAP = 32_000;
const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.5;
const CONTEXT_COMPACTION_TARGET_RATIO = 0.25;

export async function callModel(
  messages: ModelMessage[],
  tools: Anthropic.Tool[],
  system?: string,
  onTextDelta?: (text: string) => void,
  model: ChatModelId = defaultChatModel,
): Promise<Anthropic.Message> {
  const result = await callModelWithProvider({
    messages,
    tools,
    system,
    onTextDelta,
    model,
  });

  return result as Anthropic.Message;
}

const COMPACTION_SYSTEM_PROMPT = `你负责压缩较早的对话上下文，供同一个 agent 继续完成当前任务。
请保留可执行状态、用户约束、关键决定、涉及文件、工具结果和未解决问题。
不要编造事实；不确定的信息请标注为“不确定”。
使用简洁 bullet，移除寒暄、重复表达和无关细节。`;

function buildCompactionPrompt(input: {
  digest: string;
  targetTokens: number;
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

目标长度：约 ${input.targetTokens} tokens。
中间历史消息数：${input.middleMessageCount}

中间历史：
${input.digest}`;
}

export async function callCompressionModel(input: {
  digest: string;
  targetTokens: number;
  middleMessageCount: number;
  model?: ChatModelId;
}): Promise<string> {
  return generateTextWithProvider({
    model: input.model ?? "deepseek-v4-flash",
    maxOutputTokens: Math.min(Math.max(512, input.targetTokens), 2_000),
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: buildCompactionPrompt(input),
  });
}

export async function executeTools(
  toolUses: ToolUseBlock[],
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
) {
  const toolResultBlocks: Array<ToolResultBlock> = [];
  const toolSources: Array<ToolSourceType> = [];
  const toolCalls: ToolCallEventData[] = [];
  const toolSteps: ToolTraceStep[] = [];
  const toolMetrics: Array<{
    name: string;
    durationMs?: number;
    costPerUse: number;
  }> = [];
  const executionResults = await executeToolUsesWithScheduler(
    toolUses,
    toolRegistry,
    scopeId,
    userId,
  );
  for (const { toolUse, toolResult } of executionResults) {
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
    const rawPreview = truncateToolContent(toolResult.content, 1_200);
    toolResultBlocks.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: truncated.content,
      is_error: !toolResult.ok,
    });
    // 不再拼 marker 字符串，直接造结构化事件 payload（前端按 type 分发，不靠分隔符切割）
    toolCalls.push({
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
      ok: toolResult.ok,
      content: truncated.content,
      truncated: truncated.truncated,
      originalChars: truncated.originalChars,
      error: toolResult.error,
      metadata: {
        ...toolResult.metadata,
        modelContentCompressed: truncated.content !== rawPreview.content,
        rawContentPreview: rawPreview.content,
        rawContentTruncated: rawPreview.truncated,
        rawContentOriginalChars: rawPreview.originalChars,
      },
    });
    toolSteps.push({
      type: "tool",
      index: 0,
      startedAt: Date.now(),
      durationMs,
      name: toolUse.name,
      input: toolUse.input,
      ok: toolResult.ok,
      toolCallId: toolUse.id,
      contentSummary: truncated.content,
      contentTruncated: truncated.truncated,
      contentOriginalChars: truncated.originalChars,
      rawContentSummary: rawPreview.content,
      rawContentTruncated: rawPreview.truncated,
      rawContentOriginalChars: rawPreview.originalChars,
      error: toolResult.error,
      metadata: toolResult.metadata,
      costPerUse,
    });
  }
  return {
    toolResultBlocks,
    toolSources,
    toolCalls,
    toolMetrics,
    toolSteps,
  };
}

async function executeToolUsesWithScheduler(
  toolUses: ToolUseBlock[],
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
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
      console.log("[ToolScheduler]", {
        mode: "parallel",
        group,
        maxConcurrency,
        tools: batch.map((item) => item.toolUse.name),
      });
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
            ),
          })),
        )),
      );
    }
  }

  for (const item of serial) {
    console.log("[ToolScheduler]", {
      mode: "serial",
      tool: item.toolUse.name,
      reason: item.tool
        ? {
            riskLevel: item.tool.riskLevel,
            sideEffect: item.tool.runtime.sideEffect,
            requiresConfirmation: item.tool.runtime.requiresConfirmation,
            dangerous: item.tool.runtime.dangerous,
          }
        : "unknown_tool",
    });
    results.push({
      index: item.index,
      toolUse: item.toolUse,
      toolResult: await executeSingleToolUse(item.toolUse, toolRegistry, scopeId, userId),
    });
  }

  return results.sort((a, b) => a.index - b.index);
}

function executeSingleToolUse(
  toolUse: ToolUseBlock,
  toolRegistry: ToolRegistry,
  scopeId?: string,
  userId?: string,
) {
  return executeToolCall(
    toolRegistry,
    {
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
    },
    { scopeId, userId },
  );
}

export const enqueueSources = (sources: ToolSourceType[], enqueueText: (text: string) => boolean) => {
  if (sources.length === 0) return;
  // 整批来源一次性发一个 sources 事件（替代 __SOURCES__ marker）
  enqueueEvent({ type: "sources", sources }, enqueueText);
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
  systemSegments?: Array<{ kind: string; title: string; content: string }>,
  userId?: string,
): Promise<AgentLoopResult> {
  // 防重复工具调用
  const seenToolCalls = new Set<string>();
  const tokenBudget = new TokenBudget(AGENT_LOOP_TOKEN_BUDGET);
  const trace = createTrace(requestId, sessionId);
  let stepIndex = 0; // model/tool step 共享的全局递增序号
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

  for (let i = 0; i < maxToolIterations; i++) {
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "completed",
        metrics,
        trace: finalizeTrace("completed", false),
      };
    }
    const compactionStartedAt = Date.now();
    const runtimeContextWindowTokens = Math.min(
      getModelContextWindowTokens(model),
      CONTEXT_COMPACTION_WINDOW_CAP,
    );
    const compressionModel: ChatModelId = "deepseek-v4-flash";
    const compacted = await compactLoopMessagesSemantic(loopMessages, {
      modelWindowTokens: runtimeContextWindowTokens,
      triggerRatio: CONTEXT_COMPACTION_TRIGGER_RATIO,
      targetRatio: CONTEXT_COMPACTION_TARGET_RATIO,
      primerMessages: 3,
      recentMessages: 6,
      minNewMessagesSinceLastCompression: 8,
      lastCompactedMessageCount,
      compressionModel,
      compressor: (input) =>
        callCompressionModel({
          ...input,
          model: compressionModel,
        }),
    });
    loopMessages = compacted.messages;
    if (!compacted.compacted) {
      console.log("[AgentLoopCompactionSkipped]", {
        reason: compacted.skippedReason,
        beforeTokens: compacted.beforeTokens,
        triggerTokens: compacted.triggerTokens,
        messageCount: loopMessages.length,
        lastCompactedMessageCount,
      });
    }
    if (compacted.compacted) {
      lastCompactedMessageCount = loopMessages.length;
      console.log("[AgentLoopCompaction]", {
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        middleMessageCount: compacted.middleMessageCount,
      });
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
    // Agent 每轮调模型前先问一句，当前上下文还塞得下吗
    const estimatedContextTokens = estimateTokens(JSON.stringify(loopMessages));
    const tokenBudgetSnapshot = {
      max: tokenBudget.max,
      spentBefore: tokenBudget.spent,
      remainingBefore: tokenBudget.remaining(),
      requested: estimatedContextTokens,
    };
    if (!tokenBudget.canAfford(estimatedContextTokens)) {
      enqueueEvent(
        {
          type: "text",
          content:
            "\n\n上下文预算已用尽，我会停止继续调用工具，并基于当前已有信息回答。\n\n",
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
    tokenBudget.spend(estimatedContextTokens);
    const tokenBudgetAfterSpend = {
      spentAfter: tokenBudget.spent,
      remainingAfter: tokenBudget.remaining(),
    };
    metrics.estimatedTokensSpent = tokenBudget.spent;
    metrics.modelCallCount += 1;
    const modelStartedAt = Date.now();
    // 把 enqueueText 包成 onTextDelta 回调传入，text delta 逐 token 推给前端
    const onTextDelta = (text: string) =>
      enqueueEvent({ type: "text", content: text }, enqueueText);
    let initialResponse = await deps.callModel(
      loopMessages,
      tools,
      system,
      onTextDelta,
      model,
    );
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "completed",
        metrics,
        trace: finalizeTrace("completed", false),
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
        })
      : undefined;
    if (rawUsage) {
      console.log("[ModelUsageRaw]", rawUsage);
    }
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
    // 记录本轮注入的 system prompt（截断后），供 trace 详情页展示「喂了什么上下文」
    const systemSummary = system ? summarizeText(system) : undefined;
    const modelStep: ModelTraceStep = {
      type: "model",
      model,
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
      // 文本已在 callModel 流式过程中逐 token 推出，这里只处理来源
      if (allToolSources.length > 0) {
        enqueueSources(allToolSources, enqueueText);
      }
      return {
        loopMessages,
        completed: true,
        stopReason: "completed",
        metrics,
        trace: finalizeTrace("completed", true),
      };
    }
    const toolCallKeys = toolUses.map(getToolCallKey);
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
    } = await executeTools(toolUses, toolRegistry, sessionId ?? requestId, userId);
    if (shouldStop()) {
      return {
        loopMessages,
        completed: false,
        stopReason: "completed",
        metrics,
        trace: finalizeTrace("completed", false),
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
  }
  return {
    loopMessages,
    completed: false,
    stopReason: "max_iterations",
    metrics,
    trace: finalizeTrace("max_iterations", false),
  };
}

export async function streamModelResponse(
  messages: ModelMessage[],
  system?: string,
  model: ChatModelId = defaultChatModel,
) {
  return streamTextWithProvider({
    model,
    messages,
    system,
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

    if (text && !enqueueText(text)) {
      break;
    }
  }

  const finishReason = await stream.finishReason;
  return finishReason === "length" ? "max_tokens" : "end_turn";
}
