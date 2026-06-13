import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { deepseekConfig } from "@/lib/config";
import {
  TokenBudget,
  estimateTokens,
  truncateToolContent,
} from "@/lib/agent/runtime/budget";
import { compactLoopMessages } from "@/lib/agent/runtime/compaction";
import { createTrace, summarizeText } from "@/lib/agent/runtime/trace";
import { enqueueEvent } from "@/lib/agent/runtime/events";
import type { ToolCallEventData } from "@/lib/agent/runtime/events";
import { defaultChatModel, type ChatModelId } from "@/lib/agent/models";
import Anthropic from "@anthropic-ai/sdk";
import type { Stream } from "@anthropic-ai/sdk/streaming";

// Anthropic SDK 真实类型——替代原来的 any，编译器现在能帮你检查每个字段
type ModelMessage = Anthropic.MessageParam;
type ModelContentBlock = Anthropic.Messages.ContentBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

export type AgentLoopMetrics = {
  estimatedTokensSpent: number;
  modelCallCount: number;
  toolCallCount: number;
  totalToolCost: number;
  toolDurations: Array<{
    name: string;
    durationMs?: number;
  }>;
};

import type {
  AgentTrace,
  ModelTraceStep,
  ToolTraceStep,
} from "@/lib/agent/runtime/trace";

export type AgentLoopStopReason =
  | "completed"
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
  content?: unknown;
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

// 创建 Anthropic 客户端，从配置读取
const client = new Anthropic({
  apiKey: deepseekConfig.apiKey,
  baseURL: deepseekConfig.baseURL,
});

export async function callModel(
  messages: ModelMessage[],
  tools: Anthropic.Tool[],
  system?: string,
  onTextDelta?: (text: string) => void,
  model: ChatModelId = defaultChatModel,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream({
    model,
    max_tokens: deepseekConfig.maxTokens,
    messages,
    tools,
    ...(system ? { system } : {}),
  });

  // text delta 逐 token 推给前端；tool_use block 由 SDK 在 finalMessage() 里累积
  // 模型要么输出文本、要么调工具，两者不会混在同一轮 → 工具调用轮 text delta 为空，推空串无害
  if (onTextDelta) {
    stream.on("text", (text) => onTextDelta(text));
  }

  return stream.finalMessage();
}

export async function executeTools(
  toolUses: ToolUseBlock[],
  toolRegistry: ToolRegistry,
  scopeId?: string,
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
  for (const toolUse of toolUses) {
    const toolResult = await executeToolCall(toolRegistry, {
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
    }, { scopeId });
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
    const truncated = truncateToolContent(toolResult.content, 2000);
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
      metadata: toolResult.metadata,
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
      error: toolResult.error,
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
): Promise<AgentLoopResult> {
  // 防重复工具调用
  const seenToolCalls = new Set<string>();
  const tokenBudget = new TokenBudget(24_000);
  const trace = createTrace(requestId, sessionId);
  let stepIndex = 0; // model/tool step 共享的全局递增序号
  const metrics: AgentLoopMetrics = {
    estimatedTokensSpent: 0,
    modelCallCount: 0,
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
    const compacted = compactLoopMessages(loopMessages, {
      maxTokens: 16_000,
      keepRecentMessages: 4,
    });
    loopMessages = compacted.messages;
    if (compacted.compacted) {
      console.log("[AgentLoopCompaction]", {
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
      });
    }
    // Agent 每轮调模型前先问一句，当前上下文还塞得下吗
    const estimatedContextTokens = estimateTokens(JSON.stringify(loopMessages));
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
    // 记录本轮注入的 system prompt（截断后），供 trace 详情页展示「喂了什么上下文」
    const systemSummary = system ? summarizeText(system) : undefined;
    const modelStep: ModelTraceStep = {
      type: "model",
      index: stepIndex++,
      startedAt: modelStartedAt,
      durationMs: Date.now() - modelStartedAt,
      textSummary: textSummary.content,
      textTruncated: textSummary.truncated,
      textOriginalChars: textSummary.originalChars,
      systemPrompt: systemSummary?.content,
      systemPromptTruncated: systemSummary?.truncated,
      systemPromptOriginalChars: systemSummary?.originalChars,
      requestedToolCalls: toolUses.map((t: ToolUseBlock) => ({
        name: t.name,
        id: t.id,
        input: t.input,
      })),
      estimatedContextTokens,
      usage: initialResponse.usage
        ? {
            inputTokens: initialResponse.usage.input_tokens,
            outputTokens: initialResponse.usage.output_tokens,
          }
        : undefined,
    };
    trace.steps.push(modelStep);
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
    } = await executeTools(toolUses, toolRegistry, sessionId ?? requestId);
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
  return client.messages.create({
    model,
    max_tokens: deepseekConfig.maxTokens,
    messages,
    stream: true,
    ...(system ? { system } : {}),
  });
}

export async function forwardTextStream(
  stream: Stream<Anthropic.RawMessageStreamEvent>,
  enqueueText: (text: string) => boolean,
  shouldStop: () => boolean,
) {
  for await (const chunk of stream) {
    if (shouldStop()) {
      break;
    }

    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "text_delta"
    ) {
      const text = chunk.delta.text;
      if (text && !enqueueText(text)) {
        break;
      }
    }
  }
}
