export type EmbeddingProviderId = "dashscope" | "openai-compatible";

export type UserEmbeddingConfigView = {
  provider: EmbeddingProviderId;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  modelId: string;
  dimensions: number;
  configured: boolean;
  lastTestedAt?: string;
  lastTestStatus?: "ok" | "error";
  lastTestLatencyMs?: number;
  updatedAt?: string;
  indexHealth: {
    knowledgeVectors: number;
    compatibleKnowledgeVectors: number;
    memoryVectors: number;
    compatibleMemoryVectors: number;
    hasUnknownVersion: boolean;
  };
};

export type ResolvedUserEmbeddingConfig = {
  userId: string;
  provider: EmbeddingProviderId;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  dimensions: number;
  inputPriceCnyPerMillionTokens: number | null;
};
