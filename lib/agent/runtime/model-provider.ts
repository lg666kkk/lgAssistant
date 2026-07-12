import "@/instrumentation";
import { deepseekConfig } from "@/lib/platform/config";
import type { ChatModelId } from "@/lib/agent/models";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  jsonSchema,
  streamText,
  type LanguageModelUsage,
} from "ai";
import type Anthropic from "@anthropic-ai/sdk";

type ModelMessage = Anthropic.MessageParam;
type ModelContentBlock = Anthropic.Messages.ContentBlock;
export type ModelTelemetryMetadata = Record<
  string,
  string | number | boolean | null | undefined
>;
type CompactModelTelemetryMetadata = Record<string, string | number | boolean>;

export type ModelCallResult = {
  content: ModelContentBlock[];
  stop_reason: Anthropic.Messages.StopReason;
  usage?: Anthropic.Message["usage"] & {
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};

function resolveOpenAIBaseURL() {
  if (process.env.AI_SDK_BASE_URL) return process.env.AI_SDK_BASE_URL;
  if (process.env.DEEPSEEK_OPENAI_BASE_URL)
    return process.env.DEEPSEEK_OPENAI_BASE_URL;
  if (deepseekConfig.baseURL.endsWith("/anthropic")) {
    return deepseekConfig.baseURL.replace(/\/anthropic$/, "/v1");
  }
  return deepseekConfig.baseURL;
}

const provider = createOpenAI({
  name: "deepseek",
  apiKey: deepseekConfig.apiKey,
  baseURL: resolveOpenAIBaseURL(),
});

function toAIMessage(
  message: ModelMessage,
  toolNameByCallId: Map<string, string>,
): any {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: message.content,
    };
  }

  const hasOnlyToolResults =
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block: any) => block.type === "tool_result");

  const content = message.content
    .map((block: any) => {
      if (block.type === "text") {
        return { type: "text", text: String(block.text ?? "") };
      }
      if (block.type === "tool_use") {
        toolNameByCallId.set(block.id, block.name);
        return {
          type: "tool-call",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool-result",
          toolCallId: block.tool_use_id,
          toolName: toolNameByCallId.get(block.tool_use_id) ?? "unknown",
          input: {},
          output: {
            type: "text",
            value: stringifyToolResultContent(block.content),
          },
        };
      }
      return undefined;
    })
    .filter(Boolean);

  return {
    role: hasOnlyToolResults ? "tool" : message.role,
    content,
  };
}

function stringifyToolResultContent(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function toAITools(tools: Anthropic.Tool[]) {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.input_schema as any),
      },
    ]),
  );
}

function toAIMessages(messages: ModelMessage[]) {
  const toolNameByCallId = new Map<string, string>();
  return messages.map((message) => toAIMessage(message, toolNameByCallId));
}

function toAnthropicUsage(
  usage?: LanguageModelUsage,
): ModelCallResult["usage"] {
  if (!usage) return undefined;
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
  } as ModelCallResult["usage"];
}

function toStopReason(finishReason?: string): Anthropic.Messages.StopReason {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool-calls") return "tool_use";
  return "end_turn";
}

function compactMetadata(
  metadata?: ModelTelemetryMetadata,
): CompactModelTelemetryMetadata | undefined {
  if (!metadata) return undefined;
  const compacted: CompactModelTelemetryMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    compacted[key] = value;
  }
  return compacted;
}

export async function callModelWithProvider(input: {
  messages: ModelMessage[];
  tools: Anthropic.Tool[];
  system?: string;
  onTextDelta?: (text: string) => void;
  model: ChatModelId;
  telemetryFunctionId?: string;
  telemetryMetadata?: ModelTelemetryMetadata;
}): Promise<ModelCallResult> {
  const result = streamText({
    model: provider.chat(input.model),
    maxOutputTokens: deepseekConfig.maxTokens,
    temperature: deepseekConfig.temperature,
    system: input.system,
    messages: toAIMessages(input.messages),
    tools: toAITools(input.tools),
    experimental_telemetry: {
      isEnabled: true,
      functionId: input.telemetryFunctionId ?? "agent-loop-model-call",
      metadata: compactMetadata({
        ...input.telemetryMetadata,
        model: input.model,
        hasTools: input.tools.length > 0,
        messageCount: input.messages.length,
        toolCount: input.tools.length,
      }),
    },
  });
  let text = "";
  let finishReason: string | undefined;
  let usage: LanguageModelUsage | undefined;
  const toolCalls: any[] = [];

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
      input.onTextDelta?.(part.text);
    } else if (part.type === "tool-call") {
      toolCalls.push(part);
    } else if (part.type === "finish") {
      finishReason = part.finishReason;
      usage = part.totalUsage;
    } else if (part.type === "error") {
      throw part.error;
    }
  }

  const content: ModelContentBlock[] = [];
  if (text) {
    content.push({
      type: "text",
      text,
      citations: [],
    } as Anthropic.Messages.TextBlock);
  }
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.toolCallId,
      name: call.toolName,
      input: call.input,
    } as Anthropic.Messages.ToolUseBlock);
  }

  return {
    content,
    stop_reason: toStopReason(finishReason),
    usage: toAnthropicUsage(usage),
  };
}

export async function generateTextWithProvider(input: {
  prompt: string;
  system?: string;
  model: ChatModelId;
  maxOutputTokens: number;
  telemetryFunctionId?: string;
  telemetryMetadata?: ModelTelemetryMetadata;
}) {
  const result = await generateText({
    model: provider.chat(input.model),
    maxOutputTokens: input.maxOutputTokens,
    temperature: deepseekConfig.temperature,
    system: input.system,
    prompt: input.prompt,
    experimental_telemetry: {
      isEnabled: true,
      functionId: input.telemetryFunctionId ?? "generate-text",
      metadata: compactMetadata({
        ...input.telemetryMetadata,
        model: input.model,
      }),
    },
  });

  return result.text;
}

export async function streamTextWithProvider(input: {
  messages: ModelMessage[];
  system?: string;
  model: ChatModelId;
  telemetryMetadata?: ModelTelemetryMetadata;
}) {
  const result = streamText({
    model: provider.chat(input.model),
    maxOutputTokens: deepseekConfig.maxTokens,
    temperature: deepseekConfig.temperature,
    system: input.system,
    messages: toAIMessages(input.messages),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "final-answer-stream",
      metadata: compactMetadata({
        ...input.telemetryMetadata,
        model: input.model,
        messageCount: input.messages.length,
      }),
    },
  });

  return {
    textStream: result.textStream,
    finishReason: result.finishReason,
  };
}
