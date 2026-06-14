export type ChatModelId =
  | "deepseek-v4-pro"
  | "deepseek-v4-flash";

export type ModelUsageBreakdown = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  estimatedCostCny: number;
  inputCacheHitCostCny: number;
  inputCacheMissCostCny: number;
  outputCostCny: number;
};

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
  }
];

export const defaultChatModel: ChatModelId = "deepseek-v4-pro";

export function resolveChatModel(model: unknown): ChatModelId {
  return chatModelOptions.some((option) => option.id === model)
    ? (model as ChatModelId)
    : defaultChatModel;
}

export function getChatModelOption(model: ChatModelId) {
  return chatModelOptions.find((option) => option.id === model);
}

export function getModelPricing(model: ChatModelId): ModelPricingCnyPerMillionTokens {
  return getChatModelOption(model)?.pricing ?? chatModelOptions[0].pricing;
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
): ModelUsageBreakdown {
  const rawInputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheHitTokens = usage.cacheHitTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const cacheMissTokens =
    usage.cacheMissTokens ??
    Math.max(0, rawInputTokens + cacheCreationTokens);
  const inputTokens = cacheMissTokens + cacheHitTokens;
  const pricing = getModelPricing(model);
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
  };
}
