import { getSupabase } from "@/lib/platform/supabase";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import { decryptRuntimeConfigValue, encryptRuntimeConfigValue } from "@/lib/runtime-config/service";
import {
  DEFAULT_MEMORY_RERANK_INSTRUCT,
  DEFAULT_MEMORY_RERANK_MODEL,
} from "@/lib/agent/memory/memory-reranker";
import type { MemoryFusionStrategy } from "@/lib/agent/memory/fusion";
import type { MemoryExecutionConfig, UserMemoryConfigView } from "./types";

type ConfigRow = {
  enabled: boolean;
  recall_limit: number;
  recall_threshold: number;
  write_confidence: number;
  ambiguous_candidate_threshold: number;
  keyword_admit_threshold: number;
  fusion_strategy: MemoryFusionStrategy;
  rerank_enabled: boolean;
  rerank_mode: "always" | "conditional";
  rerank_model: string;
  rerank_url: string;
  rerank_api_key_ciphertext: string;
  rerank_api_key_hint: string;
  rerank_instruct: string;
  rerank_candidate_count: number;
  rerank_admit_threshold: number | null;
  rerank_timeout_ms: number;
};

const cache = new Map<string, { expiresAt: number; value: MemoryExecutionConfig | null }>();

function defaultConfig(): MemoryExecutionConfig {
  return {
    enabled: false,
    recallLimit: 3,
    recallThreshold: 0.68,
    writeConfidence: 0.72,
    ambiguousCandidateThreshold: 0.85,
    keywordAdmitThreshold: 0.5,
    fusionStrategy: "weighted",
    rerank: {
      enabled: false,
      mode: "always",
      candidateCount: 12,
      timeoutMs: 1_200,
      configured: false,
      model: DEFAULT_MEMORY_RERANK_MODEL,
      instruct: DEFAULT_MEMORY_RERANK_INSTRUCT,
      url: "",
      apiKey: "",
    },
  };
}

function fromRow(row: ConfigRow): MemoryExecutionConfig {
  const apiKey = row.rerank_api_key_ciphertext
    ? decryptRuntimeConfigValue(row.rerank_api_key_ciphertext)
    : "";
  return {
    enabled: row.enabled,
    recallLimit: row.recall_limit,
    recallThreshold: row.recall_threshold,
    writeConfidence: row.write_confidence,
    ambiguousCandidateThreshold: row.ambiguous_candidate_threshold,
    keywordAdmitThreshold: row.keyword_admit_threshold,
    fusionStrategy: row.fusion_strategy,
    rerank: {
      enabled: row.rerank_enabled,
      mode: row.rerank_mode,
      model: row.rerank_model,
      url: row.rerank_url,
      apiKey,
      configured: Boolean(row.rerank_url && apiKey),
      instruct: row.rerank_instruct,
      candidateCount: row.rerank_candidate_count,
      admitThreshold: row.rerank_admit_threshold ?? undefined,
      timeoutMs: row.rerank_timeout_ms,
    },
  };
}

function keyHint(value: string) {
  const trimmed = value.trim();
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function isMissingTable(error: { code?: string; message?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

export async function resolveUserMemoryConfig(userId: string): Promise<MemoryExecutionConfig | null> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { data, error } = await getSupabase().from("user_memory_config")
    .select("*").eq("user_id", userId).maybeSingle();
  if (error && !isMissingTable(error)) throw new Error(`读取记忆配置失败: ${error.message}`);
  const value = data ? fromRow(data as ConfigRow) : null;
  cache.set(userId, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

export async function getUserMemoryConfigView(userId: string): Promise<UserMemoryConfigView> {
  const { data, error } = await getSupabase().from("user_memory_config")
    .select("*").eq("user_id", userId).maybeSingle();
  if (error && !isMissingTable(error)) throw new Error(`读取记忆配置失败: ${error.message}`);
  if (!data) {
    const defaults = defaultConfig();
    return {
      enabled: false,
      recallLimit: defaults.recallLimit,
      recallThreshold: defaults.recallThreshold,
      writeConfidence: defaults.writeConfidence,
      ambiguousCandidateThreshold: defaults.ambiguousCandidateThreshold,
      keywordAdmitThreshold: defaults.keywordAdmitThreshold,
      fusionStrategy: defaults.fusionStrategy,
      rerank: {
        enabled: defaults.rerank.enabled,
        mode: defaults.rerank.mode,
        candidateCount: defaults.rerank.candidateCount,
        timeoutMs: defaults.rerank.timeoutMs,
        configured: false,
        model: defaults.rerank.model,
        instruct: defaults.rerank.instruct,
        admitThreshold: defaults.rerank.admitThreshold,
        url: "",
        apiKeyConfigured: false,
        apiKeyHint: "",
      },
    };
  }
  const row = data as ConfigRow;
  const resolved = fromRow(row);
  return {
    enabled: resolved.enabled,
    recallLimit: resolved.recallLimit,
    recallThreshold: resolved.recallThreshold,
    writeConfidence: resolved.writeConfidence,
    ambiguousCandidateThreshold: resolved.ambiguousCandidateThreshold,
    keywordAdmitThreshold: resolved.keywordAdmitThreshold,
    fusionStrategy: resolved.fusionStrategy,
    rerank: {
      enabled: resolved.rerank.enabled,
      mode: resolved.rerank.mode,
      candidateCount: resolved.rerank.candidateCount,
      timeoutMs: resolved.rerank.timeoutMs,
      configured: resolved.rerank.configured,
      model: resolved.rerank.model,
      instruct: resolved.rerank.instruct,
      admitThreshold: resolved.rerank.admitThreshold,
      url: row.rerank_url,
      apiKeyConfigured: Boolean(row.rerank_api_key_ciphertext),
      apiKeyHint: row.rerank_api_key_hint,
    },
  };
}

function bounded(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 超出允许范围`);
  return value;
}

export async function updateUserMemoryConfig(input: {
  userId: string;
  config: UserMemoryConfigView;
  apiKey?: string;
}) {
  const config = input.config;
  if (!(["vector_only", "weighted", "rrf"] as string[]).includes(config.fusionStrategy)) {
    throw new Error("融合策略无效");
  }
  const url = config.rerank.url.trim()
    ? await assertPublicProviderUrl(config.rerank.url)
    : "";
  const apiKey = input.apiKey?.trim();
  const existing = await getSupabase().from("user_memory_config")
    .select("rerank_api_key_ciphertext").eq("user_id", input.userId).maybeSingle();
  if (existing.error && !isMissingTable(existing.error)) throw new Error(`读取记忆配置失败: ${existing.error.message}`);
  const hasKey = Boolean(apiKey || existing.data?.rerank_api_key_ciphertext);
  if (config.rerank.enabled && (!url || !hasKey)) throw new Error("启用模型重排前必须配置 URL 和 API Key");
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    enabled: config.enabled,
    recall_limit: Math.floor(bounded(config.recallLimit, 1, 10, "召回数量")),
    recall_threshold: bounded(config.recallThreshold, 0, 1, "召回阈值"),
    write_confidence: bounded(config.writeConfidence, 0, 1, "写入置信度"),
    ambiguous_candidate_threshold: bounded(config.ambiguousCandidateThreshold, 0, 1, "含糊候选阈值"),
    keyword_admit_threshold: bounded(config.keywordAdmitThreshold, 0, 1, "关键词准入阈值"),
    fusion_strategy: config.fusionStrategy,
    rerank_enabled: config.rerank.enabled,
    rerank_mode: config.rerank.mode,
    rerank_model: config.rerank.model.trim() || DEFAULT_MEMORY_RERANK_MODEL,
    rerank_url: url,
    rerank_instruct: config.rerank.instruct.trim() || DEFAULT_MEMORY_RERANK_INSTRUCT,
    rerank_candidate_count: Math.floor(bounded(config.rerank.candidateCount, 2, 24, "重排候选数")),
    rerank_admit_threshold: config.rerank.admitThreshold == null ? null : bounded(config.rerank.admitThreshold, 0, 1, "重排准入阈值"),
    rerank_timeout_ms: Math.floor(bounded(config.rerank.timeoutMs, 200, 8_000, "重排超时")),
    updated_at: new Date().toISOString(),
  };
  if (apiKey) {
    payload.rerank_api_key_ciphertext = encryptRuntimeConfigValue(apiKey);
    payload.rerank_api_key_hint = keyHint(apiKey);
  } else if (!existing.data?.rerank_api_key_ciphertext) {
    payload.rerank_api_key_ciphertext = "";
    payload.rerank_api_key_hint = "";
  }
  const { error } = await getSupabase().from("user_memory_config")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw new Error(`保存记忆配置失败: ${error.message}`);
  cache.delete(input.userId);
}
