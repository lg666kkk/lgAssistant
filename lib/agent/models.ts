import { getRememberedModelMetadata } from "@/lib/llm/model-metadata-cache";
import type { ChatModelId, ModelUsageBreakdown } from "@repo/contracts";

export type { ChatModelId, ModelUsageBreakdown } from "@repo/contracts";

export type ModelPricingCnyPerMillionTokens = {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
};

export type ChatModelOption = {
  id: ChatModelId;
  name: string;
  description: string;
  badge?: string;
  pricing: ModelPricingCnyPerMillionTokens;
};

export const chatModelOptions: ChatModelOption[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "默认模型，适合通用对话和工具调用",
    badge: "默认",
    pricing: {
      inputCacheHit: 0.025,
      inputCacheMiss: 3,
      output: 6,
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "轻量通用模型，适合日常问答",
    pricing: {
      inputCacheHit: 0.02,
      inputCacheMiss: 1,
      output: 2,
    },
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision",
    description: "实验多模态模型，支持图片理解和工具调用",
    badge: "视觉",
    pricing: {
      inputCacheHit: 0.02,
      inputCacheMiss: 1,
      output: 2,
    },
  }
];

export const defaultChatModel: ChatModelId = "deepseek-v4-pro";

export function getModelContextWindowTokens(model: ChatModelId): number {
  const configured = getRememberedModelMetadata(model);
  if (configured) return configured.contextWindow;
  switch (model) {
    case "deepseek-v4-pro":
    case "deepseek-v4-flash":
    case "deepseek-v4-flash-vision-exp":
      return 128_000;
    default:
      return 32_000;
  }
}

export function resolveChatModel(model: unknown): ChatModelId {
  return chatModelOptions.some((option) => option.id === model)
    ? (model as ChatModelId)
    : defaultChatModel;
}

export function getChatModelOption(model: ChatModelId) {
  return chatModelOptions.find((option) => option.id === model);
}

export function supportsImageInput(model: ChatModelId) {
  return getRememberedModelMetadata(model)?.supportsImages
    ?? model === "deepseek-v4-flash-vision-exp";
}

export function getModelPricing(model: ChatModelId): ModelPricingCnyPerMillionTokens {
  return getChatModelOption(model)?.pricing ?? {
    inputCacheHit: 0,
    inputCacheMiss: 0,
    output: 0,
  };
}

export function calculateModelUsageCost(
  model: ChatModelId,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    cacheCreationTokens?: number;
  },
  pricingOverride?: ModelPricingCnyPerMillionTokens,
): ModelUsageBreakdown {
  const rawInputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheHitTokens = usage.cacheHitTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const cacheMissTokens =
    usage.cacheMissTokens ??
    Math.max(0, rawInputTokens + cacheCreationTokens);
  const inputTokens = cacheMissTokens + cacheHitTokens;
  const configuredOption = getChatModelOption(model);
  const pricing = pricingOverride ?? configuredOption?.pricing ?? {
    inputCacheHit: 0,
    inputCacheMiss: 0,
    output: 0,
  };
  const pricingConfigured = Boolean(pricingOverride || configuredOption);
  const inputCacheHitCostCny =
    (cacheHitTokens / 1_000_000) * pricing.inputCacheHit;
  const inputCacheMissCostCny =
    (cacheMissTokens / 1_000_000) * pricing.inputCacheMiss;
  const outputCostCny = (outputTokens / 1_000_000) * pricing.output;
  const inputMeasured = cacheHitTokens + cacheMissTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheCreationTokens,
    cacheHitRate: inputMeasured > 0 ? cacheHitTokens / inputMeasured : 0,
    inputCacheHitCostCny,
    inputCacheMissCostCny,
    outputCostCny,
    estimatedCostCny:
      inputCacheHitCostCny + inputCacheMissCostCny + outputCostCny,
    pricingConfigured,
    pricing: pricingConfigured ? pricing : undefined,
  };
}
