import {
  HttpCrossEncoderReranker,
  type CrossEncoderReranker,
} from "@/lib/knowledge/reranker";
import { getActiveTraceId, startActiveObservation } from "@langfuse/tracing";
import { redactSensitiveValue } from "@/lib/agent/rag/governance";
import { withSpanLabel } from "@/lib/agent/observability/span-labels";
import type { MemoryRecord } from "./types";

export const DEFAULT_MEMORY_RERANK_MODEL = "qwen3-rerank";
export const DEFAULT_MEMORY_RERANK_INSTRUCT =
  "Given a user memory retrieval query, retrieve relevant personal memory passages that answer the query.";

export type MemoryRerankConfig = {
  enabled: boolean;
  mode: "conditional" | "always";
  candidateCount: number;
  timeoutMs: number;
  configured: boolean;
  model: string;
  instruct: string;
  /** 未配置时只采集模型分数，最终准入回退原规则。 */
  admitThreshold?: number;
  url?: string;
  apiKey?: string;
};

export type MemoryRerankCandidateTrace = {
  id: string;
  key: string;
  type: string;
  source: string;
  status: string;
  confidence: number;
  importance: number;
  content: string;
  fusedScore: number | null;
  vectorScore: number | null;
  keywordScore: number | null;
  ruleScore: number;
  crossEncoderScore: number | null;
  finalScore: number;
  rankBefore: number;
  rankAfter: number;
  inRerankPool: boolean;
  admitted: boolean;
  admissionReason: string;
  rescuedByReranker: boolean;
  selected: boolean;
};

export type MemoryRerankTrace = {
  enabled: boolean;
  configured: boolean;
  mode: "conditional" | "always";
  model: string;
  instruct: string;
  candidateCount: number;
  candidateLimit: number;
  admitThreshold: number | null;
  used: boolean;
  reason: string;
  latencyMs: number;
  providerRequestId?: string;
  providerModel?: string;
  totalTokens?: number;
  error?: string;
  candidates: MemoryRerankCandidateTrace[];
};

export function getMemoryRerankConfig(): MemoryRerankConfig {
  return {
    enabled: false,
    mode: "always",
    candidateCount: 12,
    timeoutMs: 1_200,
    configured: false,
    model: DEFAULT_MEMORY_RERANK_MODEL,
    instruct: DEFAULT_MEMORY_RERANK_INSTRUCT,
    url: "",
    apiKey: "",
  };
}

export function createEmptyMemoryRerankTrace(
  reason: string,
  config = getMemoryRerankConfig(),
): MemoryRerankTrace {
  return {
    enabled: config.enabled,
    configured: config.configured,
    mode: config.mode,
    model: config.model,
    instruct: config.instruct,
    candidateCount: 0,
    candidateLimit: config.candidateCount,
    admitThreshold: config.admitThreshold ?? null,
    used: false,
    reason,
    latencyMs: 0,
    candidates: [],
  };
}

export function createConfiguredMemoryReranker(
  config = getMemoryRerankConfig(),
): CrossEncoderReranker | undefined {
  const url = config.url?.trim();
  const apiKey = config.apiKey?.trim();

  if (!url || !apiKey) return undefined;

  const delegate = new HttpCrossEncoderReranker({
    url,
    apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    instruct: config.instruct,
  });
  return {
    rerank: async (input) => {
      const execute = () => delegate.rerank(input);
      if (!getActiveTraceId()) return execute();

      return startActiveObservation("memory.rerank", async (observation) => {
        observation.update({
          input: redactSensitiveValue({
            model: config.model,
            instruct: config.instruct,
            query: input.query,
            documents: input.documents,
          }),
          metadata: withSpanLabel("memory.rerank", {
            model: config.model,
            candidateCount: input.documents.length,
          }),
        });
        try {
          const scores = await execute();
          observation.update({
            output: redactSensitiveValue({
              model: config.model,
              scores,
              providerResponse: scores.providerResponse,
            }),
          });
          return scores;
        } catch (error) {
          observation.update({
            level: "ERROR",
            output: {
              model: config.model,
              error: redactSensitiveValue(error instanceof Error ? error.message : String(error)),
            },
          });
          throw error;
        }
      }, { asType: "retriever" });
    },
  };
}

export function formatMemoryRerankDocument(record: MemoryRecord) {
  return [
    `key: ${record.key}`,
    `type: ${record.type}`,
    record.content,
  ].join("\n");
}
