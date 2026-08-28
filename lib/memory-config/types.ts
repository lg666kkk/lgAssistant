import type { MemoryFusionStrategy } from "@/lib/agent/memory/fusion";
import type { MemoryRerankConfig } from "@/lib/agent/memory/memory-reranker";

export type MemoryExecutionConfig = {
  enabled: boolean;
  recallLimit: number;
  recallThreshold: number;
  writeConfidence: number;
  ambiguousCandidateThreshold: number;
  keywordAdmitThreshold: number;
  fusionStrategy: MemoryFusionStrategy;
  rerank: MemoryRerankConfig;
};

export type UserMemoryConfigView = Omit<MemoryExecutionConfig, "rerank"> & {
  rerank: Omit<MemoryRerankConfig, "apiKey" | "url"> & {
    url: string;
    apiKeyConfigured: boolean;
    apiKeyHint: string;
  };
};
