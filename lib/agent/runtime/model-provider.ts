import { prepareRequestContext, assertRequestContextFits } from "./request-context";
import { hydrateKnowledgeMedia } from './knowledge-media';
import type { ChatModelId } from "@/lib/agent/models";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  jsonSchema,
  streamText,
  type LanguageModelUsage,
} from "ai";
import type Anthropic from "@anthropic-ai/sdk";
import { createModelTextFilter, sanitizeModelText } from "@/lib/agent/runtime/output-sanitizer";
import { resolveUserLlmModel } from "@/lib/llm/config-service";
import { createSafeProviderFetch } from "@/lib/llm/url-safety";
import type { LlmReasoningMode, ResolvedUserLlmModel } from "@/lib/llm/types";
import { resolveThinkingMode } from "@/lib/llm/reasoning";
import type { ModelPricingCnyPerMillionTokens } from "@/lib/agent/models";
import {
  SPAN_LABEL_METADATA_KEY,
  resolveSpanLabel,
} from "@/lib/agent/observability/span-labels";

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
  reasoning_content?: string;
  usage?: Anthropic.Message["usage"] & {
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  pricing?: ModelPricingCnyPerMillionTokens;
  modelName?: string;
  providerName?: string;
  providerModelId?: string;
};

export type DeepSeekReasoningEffort = "low" | "high" | "max";

type DeepSeekAssistantMessage = ModelMessage & {
  reasoning_content?: string;
};

function isChatCompletionsRequest(input: RequestInfo | URL) {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  return url.includes("/chat/completions");
}

function withReasoningBody(
  body: string,
  mode: LlmReasoningMode,
  messages: DeepSeekAssistantMessage[] = [],
) {
  if (mode === "none" && !messages.some((message) => message.reasoning_content)) return body;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  mode = resolveThinkingMode(mode, "", typeof payload.model === "string" ? payload.model : "");
  try {
    if (mode === "qwen" || mode === "qwen-off") {
      payload.enable_thinking = mode === "qwen";
    } else if (mode !== "none") {
      payload.thinking = { type: mode.endsWith("-off") ? "disabled" : "enabled" };
    }
    if (mode === "deepseek") {
      payload.reasoning_effort = "high";
      delete payload.temperature;
      delete payload.top_p;
      delete payload.presence_penalty;
      delete payload.frequency_penalty;
    } else if (mode !== "none") {
      // Thinking APIs may enforce model-specific sampling defaults.
      delete payload.temperature;
    }

    if (!mode.endsWith("-off") && Array.isArray(payload.messages)) {
      const assistantReasoning = messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content);
      let assistantIndex = 0;
      payload.messages = payload.messages.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          return message;
        }
        if ((message as { role?: unknown }).role !== "assistant") return message;
        const reasoningContent = assistantReasoning[assistantIndex++];
        return typeof reasoningContent === "string" && reasoningContent
          ? { ...message, reasoning_content: reasoningContent }
          : message;
      });
    }

    return JSON.stringify(payload);
  } catch {
    return body;
  }
}

function reasoningDeltaFromSseLine(line: string) {
  if (!line.startsWith("data:")) return "";
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return "";
  try {
    const payload = JSON.parse(data) as {
      choices?: Array<{ delta?: { reasoning_content?: unknown } }>;
    };
    const reasoningDelta = payload.choices?.[0]?.delta?.reasoning_content;
    return typeof reasoningDelta === "string" ? reasoningDelta : "";
  } catch {
    return "";
  }
}

function observeReasoningStream(
  response: Response,
  onReasoningDelta?: (text: string) => void,
) {
  if (!response.body || !onReasoningDelta) return response;
  const decoder = new TextDecoder();
  let pending = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const reasoningDelta = reasoningDeltaFromSseLine(line);
        if (reasoningDelta) onReasoningDelta(reasoningDelta);
      }
      controller.enqueue(chunk);
    },
    flush() {
      pending += decoder.decode();
      const reasoningDelta = reasoningDeltaFromSseLine(pending);
      if (reasoningDelta) onReasoningDelta(reasoningDelta);
    },
  }));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createDeepSeekThinkingFetch(
  baseFetch: typeof fetch = fetch,
  messages: DeepSeekAssistantMessage[] = [],
  onReasoningDelta?: (text: string) => void,
): typeof fetch {
  return createReasoningFetch("deepseek", baseFetch, messages, onReasoningDelta);
}

export function createReasoningFetch(
  mode: LlmReasoningMode,
  baseFetch: typeof fetch = fetch,
  messages: DeepSeekAssistantMessage[] = [],
  onReasoningDelta?: (text: string) => void,
): typeof fetch {
  return async (input, init) => {
    if (
      !isChatCompletionsRequest(input)
      || typeof init?.body !== "string"
    ) {
      return baseFetch(input, init);
    }
    const response = await baseFetch(input, {
      ...init,
      body: withReasoningBody(init.body, mode, messages),
    });
    return observeReasoningStream(response, onReasoningDelta);
  };
}

export function createStrategyDiagnosticFetch(
  baseFetch: typeof fetch,
  requestId: string | number | boolean | null | undefined,
  model: ChatModelId,
): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    console.info("[execution.strategy] HTTP request started", { requestId, model });
    try {
      const response = await baseFetch(input, init);
      console.info("[execution.strategy] HTTP headers received", {
        requestId, model, elapsedMs: Date.now() - startedAt, httpStatus: response.status,
      });
      return response;
    } catch (error) {
      const details = error as { name?: unknown; code?: unknown } | null;
      console.error("[execution.strategy] HTTP request failed", {
        requestId, model, elapsedMs: Date.now() - startedAt,
        errorName: typeof details?.name === "string" ? details.name : typeof error,
        errorCode: typeof details?.code === "string" ? details.code : undefined,
      });
      throw error;
    }
  };
}

type ExecutionModel = Pick<
  ResolvedUserLlmModel,
  "modelId" | "displayName" | "providerName" | "baseUrl" | "apiKey" | "contextWindow" | "maxOutputTokens" | "temperature" | "reasoningMode" | "pricing" | "supportsImages"
>;

function configuredPricing(
  pricing: ResolvedUserLlmModel["pricing"],
): ModelPricingCnyPerMillionTokens | undefined {
  if (
    pricing.inputCacheHit === null
    || pricing.inputCacheMiss === null
    || pricing.output === null
  ) return undefined;
  return {
    inputCacheHit: pricing.inputCacheHit,
    inputCacheMiss: pricing.inputCacheMiss,
    output: pricing.output,
  };
}

async function resolveExecutionModel(
  model: ChatModelId,
  telemetryMetadata?: ModelTelemetryMetadata,
): Promise<ExecutionModel> {
  const userId = typeof telemetryMetadata?.userId === "string"
    ? telemetryMetadata.userId
    : undefined;
  if (!userId) throw new Error("当前模型调用缺少用户配置上下文");
  return resolveUserLlmModel(userId, model);
}

async function createProvider(
  model: ChatModelId,
  telemetryMetadata?: ModelTelemetryMetadata,
  messages: ModelMessage[] = [],
  onReasoningDelta?: (text: string) => void,
) {
  const runtimeModel = await resolveExecutionModel(model, telemetryMetadata);
  const requestMessages = [...messages];
  const safeFetch = createSafeProviderFetch(runtimeModel.baseUrl);
  const observedFetch = telemetryMetadata?.operation === "execution.strategy"
    ? createStrategyDiagnosticFetch(safeFetch, telemetryMetadata.requestId, model)
    : safeFetch;
  const providerFetch = createReasoningFetch(
    resolveThinkingMode(runtimeModel.reasoningMode, runtimeModel.baseUrl, runtimeModel.modelId),
    observedFetch,
    requestMessages as DeepSeekAssistantMessage[],
    onReasoningDelta,
  );
  const provider = createOpenAI({
    name: "user-openai-compatible",
    apiKey: runtimeModel.apiKey,
    baseURL: runtimeModel.baseUrl,
    fetch: providerFetch,
  });
  return {
    model: provider.chat(runtimeModel.modelId),
    runtimeModel,
    setRequestMessages(next: ModelMessage[]) {
      requestMessages.splice(0, requestMessages.length, ...next);
    },
  };
}

export function toAIMessage(
  message: ModelMessage,
  toolNameByCallId: Map<string, string>,
): any {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: message.content,
      ...(message.role === "assistant"
        && typeof (message as DeepSeekAssistantMessage).reasoning_content === "string"
        ? { reasoning_content: (message as DeepSeekAssistantMessage).reasoning_content }
        : {}),
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
      if (
        block.type === "image"
        && block.source?.type === "base64"
        && typeof block.source.data === "string"
      ) {
        return {
          type: "image",
          image: block.source.data,
          mediaType: block.source.media_type,
        };
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
    ...(message.role === "assistant"
      && typeof (message as DeepSeekAssistantMessage).reasoning_content === "string"
      ? { reasoning_content: (message as DeepSeekAssistantMessage).reasoning_content }
      : {}),
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

export function toAIMessages(messages: ModelMessage[]) {
  const toolNameByCallId = new Map<string, string>();
  const result: any[] = [];
  for (const message of messages) {
    const images: any[] = [];
    const normalized = { ...message, content: Array.isArray(message.content)
      ? message.content.map((block: any) => {
        if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
        for (const part of block.content) if (part.type === 'image') {
          images.push({ type: 'text', text: `Untrusted document image for tool_call_id=${block.tool_use_id}. Its evidence/source is identified in the preceding receipt.` }, part);
        }
        return { ...block, content: block.content.filter((part: any) => part.type !== 'image') };
      }) : message.content } as ModelMessage;
    result.push(toAIMessage(normalized, toolNameByCallId));
    // Complete every tool receipt before the user image message for compatible providers.
    if (images.length) result.push(toAIMessage({ role: 'user', content: images }, toolNameByCallId));
  }
  return result;
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

// 统一给模型调用的 telemetry 补上中文作用标识（spanLabel），
// 这样 Langfuse 里的 ai.streamText / ai.generateText 也能一眼看出这步在干什么。
function compactMetadata(
  functionId: string,
  metadata?: ModelTelemetryMetadata,
): CompactModelTelemetryMetadata {
  const compacted: CompactModelTelemetryMetadata = {
    [SPAN_LABEL_METADATA_KEY]: resolveSpanLabel(functionId),
  };
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === undefined || value === null) continue;
    compacted[key] = value;
  }
  return compacted;
}

export async function callModelWithProvider(input: {
  signal?: AbortSignal;
  messages: ModelMessage[];
  tools: Anthropic.Tool[];
  system?: string;
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  model: ChatModelId;
  telemetryFunctionId?: string;
  telemetryMetadata?: ModelTelemetryMetadata;
}): Promise<ModelCallResult> {
  const functionId = input.telemetryFunctionId ?? "agent-loop-model-call";
  let reasoningContent = "";
  const provider = await createProvider(input.model, input.telemetryMetadata, input.messages, (reasoningDelta) => {
    reasoningContent += reasoningDelta;
    input.onReasoningDelta?.(reasoningDelta);
  });
  const prepared = prepareRequestContext({
    messages: input.messages, tools: input.tools, system: input.system,
    contextWindow: provider.runtimeModel.contextWindow, maxOutputTokens: provider.runtimeModel.maxOutputTokens,
  });
  assertRequestContextFits(prepared);
  provider.setRequestMessages(prepared.messages);
  const hydrated = await hydrateKnowledgeMedia(prepared.messages,
    typeof input.telemetryMetadata?.userId === 'string' ? input.telemetryMetadata.userId : undefined,
    input.signal, provider.runtimeModel.supportsImages);
  const result = streamText({
    abortSignal: input.signal,
    model: provider.model,
    maxOutputTokens: provider.runtimeModel.maxOutputTokens,
    temperature: provider.runtimeModel.temperature,
    system: input.system,
    messages: toAIMessages(hydrated),
    tools: toAITools(input.tools),
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      functionId,
      metadata: compactMetadata(functionId, {
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
  const textFilter = createModelTextFilter();

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
      const safeText = textFilter.push(part.text);
      if (safeText) input.onTextDelta?.(safeText);
    } else if (part.type === "tool-call") {
      toolCalls.push(part);
    } else if (part.type === "finish") {
      finishReason = part.finishReason;
      usage = part.totalUsage;
    } else if (part.type === "error") {
      throw part.error;
    }
  }

  const remainingText = textFilter.finish();
  if (remainingText) input.onTextDelta?.(remainingText);
  textFilter.assertValid();
  const content: ModelContentBlock[] = [];
  input.signal?.throwIfAborted();
  const sanitizedText = sanitizeModelText(text);
  if (sanitizedText) {
    content.push({
      type: "text",
      text: sanitizedText,
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
    reasoning_content: reasoningContent || undefined,
    usage: toAnthropicUsage(usage),
    pricing: configuredPricing(provider.runtimeModel.pricing),
    modelName: provider.runtimeModel.displayName,
    providerName: provider.runtimeModel.providerName,
    providerModelId: provider.runtimeModel.modelId,
  };
}

export async function generateTextWithProvider(input: {
  prompt: string;
  system?: string;
  model: ChatModelId;
  maxOutputTokens: number;
  telemetryFunctionId?: string;
  telemetryMetadata?: ModelTelemetryMetadata;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}) {
  const logStrategy = input.telemetryFunctionId === "execution.strategy";
  const startedAt = Date.now();
  const requestId = input.telemetryMetadata?.requestId;
  let phase: "resolve_model" | "generate_text" = "resolve_model";
  try {
    const provider = await createProvider(input.model, input.telemetryMetadata);
    phase = "generate_text";
    if (logStrategy) {
      console.info("[execution.strategy] model resolved", {
        requestId, model: input.model,
        providerName: provider.runtimeModel.providerName,
        providerModelId: provider.runtimeModel.modelId,
        resolveMs: Date.now() - startedAt,
      });
    }
    const result = await generateText({
      model: provider.model,
      abortSignal: input.abortSignal,
      maxRetries: input.maxRetries,
      maxOutputTokens: input.maxOutputTokens,
      temperature: provider.runtimeModel.temperature,
      system: input.system,
      prompt: input.prompt,
      experimental_telemetry: {
        isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
        functionId: input.telemetryFunctionId ?? "generate-text",
        metadata: compactMetadata(input.telemetryFunctionId ?? "generate-text", {
          ...input.telemetryMetadata,
          model: input.model,
        }),
      },
    });
    if (logStrategy) {
      console.info("[execution.strategy] model completed", {
        requestId, model: input.model,
        totalMs: Date.now() - startedAt,
        outputChars: result.text.length,
      });
    }
    return result.text;
  } catch (error) {
    if (logStrategy) {
      const details = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown } | null;
      console.error("[execution.strategy] model failed", {
        requestId, model: input.model, phase,
        elapsedMs: Date.now() - startedAt,
        aborted: Boolean(input.abortSignal?.aborted),
        errorName: typeof details?.name === "string" ? details.name : typeof error,
        errorCode: typeof details?.code === "string" ? details.code : undefined,
        httpStatus: typeof details?.status === "number" ? details.status
          : typeof details?.statusCode === "number" ? details.statusCode : undefined,
      });
    }
    throw error;
  }
}

export async function streamTextWithProvider(input: {
  signal?: AbortSignal;
  messages: ModelMessage[];
  system?: string;
  model: ChatModelId;
  telemetryMetadata?: ModelTelemetryMetadata;
  onReasoningDelta?: (text: string) => void;
}) {
  const provider = await createProvider(
    input.model,
    input.telemetryMetadata,
    input.messages,
    input.onReasoningDelta,
  );
  const prepared = prepareRequestContext({
    messages: input.messages, tools: [], system: input.system,
    contextWindow: provider.runtimeModel.contextWindow, maxOutputTokens: provider.runtimeModel.maxOutputTokens,
  });
  assertRequestContextFits(prepared);
  provider.setRequestMessages(prepared.messages);
  const hydrated = await hydrateKnowledgeMedia(prepared.messages,
    typeof input.telemetryMetadata?.userId === 'string' ? input.telemetryMetadata.userId : undefined,
    input.signal, provider.runtimeModel.supportsImages);
  const result = streamText({
    model: provider.model,
    maxOutputTokens: provider.runtimeModel.maxOutputTokens,
    temperature: provider.runtimeModel.temperature,
    system: input.system,
    messages: toAIMessages(hydrated),
    abortSignal: input.signal,
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      functionId: "final-answer-stream",
      metadata: compactMetadata("final-answer-stream", {
        ...input.telemetryMetadata,
        model: input.model,
        messageCount: input.messages.length,
      }),
    },
  });

  async function* textStream() {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield part.text;
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    input.signal?.throwIfAborted();
  }

  return {
    textStream: textStream(),
    finishReason: result.finishReason,
  };
}
