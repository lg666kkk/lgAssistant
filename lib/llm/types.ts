export type LlmAdapterType = "openai-compatible";
export type LlmReasoningMode = "none" | "deepseek";

export type UserLlmModelPricing = {
  inputCacheHit: number | null;
  inputCacheMiss: number | null;
  output: number | null;
};

export type UserLlmModel = {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  supportsTools: boolean;
  supportsImages: boolean;
  reasoningMode: LlmReasoningMode;
  pricing: UserLlmModelPricing;
  enabled: boolean;
};

export type UserLlmProvider = {
  id: string;
  name: string;
  adapterType: LlmAdapterType;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  enabled: boolean;
  updatedAt: string;
  models: UserLlmModel[];
};

export type UserLlmPreferences = {
  defaultModelId: string | null;
  fastModelId: string | null;
  visionModelId: string | null;
};

export type UserLlmCatalog = {
  providers: UserLlmProvider[];
  models: UserLlmModel[];
  preferences: UserLlmPreferences;
};

export type UserLlmModelDraft = {
  id?: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  supportsTools: boolean;
  supportsImages: boolean;
  reasoningMode: LlmReasoningMode;
  pricing: UserLlmModelPricing;
  enabled: boolean;
};

export type ResolvedUserLlmModel = UserLlmModel & {
  userId: string;
  adapterType: LlmAdapterType;
  baseUrl: string;
  apiKey: string;
};
