import { executeToolCall } from "@/lib/agent/tools/tool-router";
import { deepseekConfig } from "@/lib/config";
import {
  TokenBudget,
  estimateTokens,
  truncateToolContent,
} from "@/lib/agent/runtime/budget";
import Anthropic from "@anthropic-ai/sdk";

type ModelMessage = any;
type ModelContentBlock = any;
type ToolUseBlock = any;

type AgentLoopStopReason =
  | "completed"
  | "token_budget_exceeded"
  | "repeated_tool_call"
  | "max_iterations";

type AgentLoopResult = {
  loopMessages: ModelMessage[];
  completed: boolean;
  stopReason: AgentLoopStopReason;
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
    .filter((block: ModelContentBlock) => block.type === "text")
    .map((block: ModelContentBlock) => block.text)
    .join("");
}

export function extractToolUses(content: ModelContentBlock[]): ToolUseBlock[] {
  return content.filter(
    (block: ModelContentBlock) => block.type === "tool_use",
  );
}

export function appendToolResults(
  loopMessages: ModelMessage[],
  assistantResponse: any,
  toolResultBlocks: ToolResultBlock[],
) {
  return [
    ...loopMessages,
    {
      role: "assistant",
      content: assistantResponse.content,
    },
    {
      role: "user",
      content: toolResultBlocks,
    },
  ];
}

export function enqueueToolMarkers(toolMarkers: string[], enqueueText: any) {
  for (const marker of toolMarkers) {
    enqueueText(marker);
  }
}

// 创建 Anthropic 客户端，从配置读取
const client = new Anthropic({
  apiKey: deepseekConfig.apiKey,
  baseURL: deepseekConfig.baseURL,
});

export async function callModel(
  messages: ModelMessage[],
  tools: any[],
): Promise<any> {
  return await client.messages.create({
    model: deepseekConfig.model,
    max_tokens: deepseekConfig.maxTokens,
    messages,
    tools,
  });
}

export async function executeTools(
  toolUses: ToolUseBlock[],
  toolRegistry: any,
) {
  const toolResultBlocks: Array<ToolResultBlock> = [];
  const toolSources: Array<ToolSourceType> = [];
  let toolMarkers: string[] = [];

  for (const toolUse of toolUses) {
    const toolResult = await executeToolCall(toolRegistry, {
      name: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
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
    const truncated = truncateToolContent(toolResult.content, 20000);
    toolResultBlocks.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: truncated.content,
      is_error: !toolResult.ok,
    });
    const toolMarker =
      "\n\n__TOOL_CALL__\n" +
      JSON.stringify({
        name: toolUse.name,
        input: toolUse.input,
        id: toolUse.id,
        ok: toolResult.ok,
        content: truncated.content,
        truncated: truncated.truncated,
        originalChars: truncated.originalChars,
        error: toolResult.error,
        metadata: toolResult.metadata,
      }) +
      "\n__END_TOOL_CALL__\n";
    toolMarkers.push(toolMarker);
  }
  return {
    toolResultBlocks,
    toolSources,
    toolMarkers,
  };
}

export const enqueueSources = (sources: ToolSourceType[], enqueueText: any) => {
  if (sources.length === 0) return;

  const sourcesMarker = "\n\n__SOURCES__\n" + JSON.stringify(sources);

  enqueueText(sourcesMarker);
};

export async function runAgentLoop(
  loopMessages: ModelMessage[],
  tools: any[],
  toolRegistry: any,
  maxToolIterations: number,
  allToolSources: ToolSourceType[],
  enqueueText: any,
): Promise<AgentLoopResult> {
  // 防重复工具调用
  const seenToolCalls = new Set<string>();
  const tokenBudget = new TokenBudget(24_000);
  for (let i = 0; i < maxToolIterations; i++) {
    // Agent 每轮调模型前先问一句，当前上下文还塞得下吗
    const estimatedContextTokens = estimateTokens(JSON.stringify(loopMessages));
    if (!tokenBudget.canAfford(estimatedContextTokens)) {
      enqueueText(
        "\n\n上下文预算已用尽，我会停止继续调用工具，并基于当前已有信息回答。\n\n",
      );
      return {
        loopMessages,
        completed: false,
        stopReason: "token_budget_exceeded",
      };
    }
    tokenBudget.spend(estimatedContextTokens);
    let initialResponse = await callModel(loopMessages, tools);
    const toolUses = extractToolUses(initialResponse.content);
    const directText = extractText(initialResponse.content);
    if (toolUses.length === 0) {
      // 直接返回文本
      if (directText) {
        enqueueText(directText);
      }
      if (allToolSources.length > 0) {
        enqueueSources(allToolSources, enqueueText);
      }
      return {
        loopMessages,
        completed: true,
        stopReason: "completed",
      };
    }
    const toolCallKeys = toolUses.map(getToolCallKey);
    const hasRepeatedToolCall = toolCallKeys.some((key) =>
      seenToolCalls.has(key),
    );
    // 用户问题重复 ≠ 工具调用重复。重复保护防的是模型 loop 卡住，不是防用户输入重复
    if (hasRepeatedToolCall) {
      enqueueText(
        "\n\n检测到重复工具调用，已停止继续执行工具。我会基于已有结果回答。\n\n",
      );
      return {
        loopMessages,
        completed: false,
        stopReason: "repeated_tool_call",
      };
    }
    for (const key of toolCallKeys) {
      seenToolCalls.add(key);
    }
    // 给模型用，作为 Anthropic tool_result 消息
    const { toolResultBlocks, toolSources, toolMarkers } = await executeTools(
      toolUses,
      toolRegistry,
    );
    enqueueToolMarkers(toolMarkers, enqueueText);
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
  };
}

export async function streamModelResponse(messages: ModelMessage[]) {
  return client.messages.create({
    model: deepseekConfig.model,
    max_tokens: deepseekConfig.maxTokens,
    messages,
    stream: true,
  });
}

export async function forwardTextStream(
  stream: any,
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
