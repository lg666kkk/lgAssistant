import { getSupabase } from "@/lib/platform/supabase";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingClient,
} from "@/lib/knowledge/embedding";
import type {
  EmbeddingProviderId,
  ResolvedUserEmbeddingConfig,
  UserEmbeddingConfigView,
} from "./types";
import { resolveUserMeteredModelPrice } from "@/lib/agent/observability/user-metered-pricing";

const TABLE = "user_embedding_configs";
const AUDIT_TABLE = "user_embedding_config_audit";
const DEFAULT_PROVIDER: EmbeddingProviderId = "dashscope";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const CACHE_TTL_MS = 30_000;

type ConfigRow = {
  user_id: string;
  provider: EmbeddingProviderId;
  base_url: string;
  api_key_ciphertext: string;
  api_key_hint: string;
  model_id: string;
  dimensions: number;
  last_tested_at: string | null;
  last_test_status: "ok" | "error" | null;
  last_test_latency_ms: number | null;
  updated_at: string;
};

const resolvedCache = new Map<string, {
  expiresAt: number;
  value: ResolvedUserEmbeddingConfig;
}>();

function isMissingSchema(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string };
  return candidate.code === "42P01"
    || candidate.code === "PGRST205"
    || candidate.message?.includes(TABLE) === true;
}

function schemaError() {
  return new Error("尚未创建用户向量配置表，请先执行 20260829-user-embedding-config.sql");
}

function apiKeyHint(value: string) {
  const trimmed = value.trim();
  return trimmed.length <= 8
    ? `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
    : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function validateProvider(value: unknown): EmbeddingProviderId {
  if (value !== "dashscope" && value !== "openai-compatible") {
    throw new Error("Embedding Provider 无效");
  }
  return value;
}

function toResolved(row: ConfigRow): ResolvedUserEmbeddingConfig {
  const apiKey = decryptRuntimeConfigValue(row.api_key_ciphertext);
  if (!apiKey) throw new Error("向量嵌入 API Key 为空，请重新保存配置");
  if (row.model_id !== EMBEDDING_MODEL || row.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error("当前向量配置与数据库索引不兼容，请恢复 text-embedding-v4 / 1024 维配置");
  }
  return {
    userId: row.user_id,
    provider: row.provider,
    baseUrl: row.base_url,
    apiKey,
    modelId: row.model_id,
    dimensions: row.dimensions,
    inputPriceCnyPerMillionTokens: null,
  };
}

async function readRow(userId: string): Promise<ConfigRow | null> {
  const { data, error } = await getSupabase().from(TABLE)
    .select("user_id,provider,base_url,api_key_ciphertext,api_key_hint,model_id,dimensions,last_tested_at,last_test_status,last_test_latency_ms,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (isMissingSchema(error)) throw schemaError();
  if (error) throw new Error(`读取向量嵌入配置失败: ${error.message}`);
  return data as ConfigRow | null;
}

async function countIndexHealth(userId: string, configured: boolean) {
  const supabase = getSupabase();
  const [knowledge, compatibleKnowledge, memory, compatibleMemory] = await Promise.all([
    supabase.from("documents").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("documents").select("id", { count: "exact", head: true })
      .eq("user_id", userId).contains("metadata", { embedding_model: EMBEDDING_MODEL }),
    supabase.from("agent_semantic_memories").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("agent_semantic_memories").select("id", { count: "exact", head: true })
      .eq("user_id", userId).contains("metadata", { embedding_model: EMBEDDING_MODEL }),
  ]);
  const errors = [knowledge.error, compatibleKnowledge.error, memory.error, compatibleMemory.error]
    .filter(Boolean);
  if (errors.length > 0) {
    console.error("[embedding-config] 读取向量索引统计失败:", errors[0]?.message);
  }
  const knowledgeVectors = knowledge.count ?? 0;
  const compatibleKnowledgeVectors = compatibleKnowledge.count ?? 0;
  const memoryVectors = memory.count ?? 0;
  const compatibleMemoryVectors = compatibleMemory.count ?? 0;
  return {
    knowledgeVectors,
    compatibleKnowledgeVectors,
    memoryVectors,
    compatibleMemoryVectors,
    hasUnknownVersion: configured && (
      compatibleKnowledgeVectors < knowledgeVectors
      || compatibleMemoryVectors < memoryVectors
    ),
  };
}

export function clearUserEmbeddingConfigCache(userId: string) {
  resolvedCache.delete(userId);
}

export async function getUserEmbeddingConfigView(
  userId: string,
): Promise<UserEmbeddingConfigView> {
  const row = await readRow(userId);
  const configured = Boolean(row?.api_key_ciphertext);
  return {
    provider: row?.provider ?? DEFAULT_PROVIDER,
    baseUrl: row?.base_url ?? DEFAULT_BASE_URL,
    apiKeyConfigured: configured,
    apiKeyHint: row?.api_key_hint ?? "",
    modelId: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    configured,
    lastTestedAt: row?.last_tested_at ?? undefined,
    lastTestStatus: row?.last_test_status ?? undefined,
    lastTestLatencyMs: row?.last_test_latency_ms ?? undefined,
    updatedAt: row?.updated_at,
    indexHealth: await countIndexHealth(userId, configured),
  };
}

export async function saveUserEmbeddingConfig(input: {
  userId: string;
  provider: EmbeddingProviderId;
  baseUrl: string;
  apiKey?: string;
}) {
  const provider = validateProvider(input.provider);
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const apiKey = input.apiKey?.trim();
  if (apiKey && apiKey.length > 4_000) throw new Error("API Key 过长");
  const existing = await readRow(input.userId);
  if (!apiKey && !existing?.api_key_ciphertext) throw new Error("首次配置必须填写 API Key");

  const payload: Record<string, unknown> = {
    user_id: input.userId,
    provider,
    base_url: baseUrl,
    model_id: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    updated_at: new Date().toISOString(),
  };
  if (apiKey) {
    payload.api_key_ciphertext = encryptRuntimeConfigValue(apiKey);
    payload.api_key_hint = apiKeyHint(apiKey);
  } else if (existing) {
    payload.api_key_ciphertext = existing.api_key_ciphertext;
    payload.api_key_hint = existing.api_key_hint;
  }
  const { error } = await getSupabase().from(TABLE)
    .upsert(payload, { onConflict: "user_id" });
  if (isMissingSchema(error)) throw schemaError();
  if (error) throw new Error(`保存向量嵌入配置失败: ${error.message}`);
  clearUserEmbeddingConfigCache(input.userId);
  await appendAudit(input.userId, "config_update", {
    provider,
    modelId: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    apiKeyRotated: Boolean(apiKey),
  });
}

export async function resolveUserEmbeddingConfig(
  userId: string,
): Promise<ResolvedUserEmbeddingConfig> {
  const cached = resolvedCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await readRow(userId);
  if (!row?.api_key_ciphertext) {
    throw new Error("请先在连接 > 向量嵌入中配置并测试 Embedding 服务");
  }
  const value = {
    ...toResolved(row),
    inputPriceCnyPerMillionTokens: await resolveUserMeteredModelPrice({
      userId,
      category: "embedding",
      modelId: row.model_id,
    }),
  };
  resolvedCache.set(userId, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function resolveUserEmbeddingCredentials(input: {
  userId: string;
  provider?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}) {
  const overrideApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (overrideApiKey) {
    if (overrideApiKey.length > 4_000) throw new Error("API Key 过长");
    return {
      userId: input.userId,
      provider: validateProvider(input.provider ?? DEFAULT_PROVIDER),
      baseUrl: await assertPublicProviderUrl(
        typeof input.baseUrl === "string" ? input.baseUrl : DEFAULT_BASE_URL,
      ),
      apiKey: overrideApiKey,
      modelId: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      inputPriceCnyPerMillionTokens: await resolveUserMeteredModelPrice({
        userId: input.userId,
        category: "embedding",
        modelId: EMBEDDING_MODEL,
      }),
    } satisfies ResolvedUserEmbeddingConfig;
  }
  const saved = await resolveUserEmbeddingConfig(input.userId);
  return {
    ...saved,
    provider: input.provider === undefined
      ? saved.provider
      : validateProvider(input.provider),
    baseUrl: input.baseUrl === undefined
      ? saved.baseUrl
      : await assertPublicProviderUrl(String(input.baseUrl)),
  };
}

export async function createUserEmbeddingClient(userId: string) {
  const config = await resolveUserEmbeddingConfig(userId);
  return {
    config,
    client: new EmbeddingClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.modelId,
      dimensions: config.dimensions,
    }),
  };
}

export async function recordEmbeddingConnectionTest(input: {
  userId: string;
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}) {
  const now = new Date().toISOString();
  const { error } = await getSupabase().from(TABLE).update({
    last_tested_at: now,
    last_test_status: input.status,
    last_test_latency_ms: input.latencyMs ?? null,
    updated_at: now,
  }).eq("user_id", input.userId);
  if (error && !isMissingSchema(error)) {
    console.error("记录 Embedding 连接测试失败:", error.message);
  }
  await appendAudit(input.userId, "connection_test", {
    status: input.status,
    latencyMs: input.latencyMs,
    error: input.error?.slice(0, 300),
  });
}

async function appendAudit(
  userId: string,
  action: "config_update" | "connection_test",
  metadata: Record<string, unknown>,
) {
  const { error } = await getSupabase().from(AUDIT_TABLE).insert({
    user_id: userId,
    action,
    metadata,
  });
  if (error && !isMissingSchema(error)) {
    console.error("记录 Embedding 配置审计失败:", error.message);
  }
}
