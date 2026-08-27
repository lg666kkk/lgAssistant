import { getSupabase } from "@/lib/platform/supabase";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import { rememberModelMetadata } from "./model-metadata-cache";
import { assertPublicProviderUrl } from "./url-safety";
import type {
  LlmAdapterType,
  LlmReasoningMode,
  ResolvedUserLlmModel,
  UserLlmCatalog,
  UserLlmModel,
  UserLlmModelDraft,
  UserLlmPreferences,
  UserLlmProvider,
} from "./types";

type ProviderRow = {
  id: string;
  user_id: string;
  name: string;
  adapter_type: LlmAdapterType;
  base_url: string;
  api_key_ciphertext: string;
  api_key_hint: string;
  enabled: boolean;
  updated_at: string;
};

type ModelRow = {
  id: string;
  user_id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  temperature: number;
  supports_tools: boolean;
  supports_images: boolean;
  reasoning_mode: LlmReasoningMode;
  enabled: boolean;
};

type PreferenceRow = {
  default_model_id: string | null;
  fast_model_id: string | null;
  vision_model_id: string | null;
};

const DEFAULT_PREFERENCES: UserLlmPreferences = {
  defaultModelId: null,
  fastModelId: null,
  visionModelId: null,
};
const RESOLVED_MODEL_CACHE_TTL_MS = 30_000;
const resolvedModelCache = new Map<string, {
  expiresAt: number;
  value: ResolvedUserLlmModel;
}>();

function cacheKey(userId: string, modelId: string) {
  return `${userId}:${modelId}`;
}

export function clearUserLlmConfigCache(userId: string) {
  for (const key of Array.from(resolvedModelCache.keys())) {
    if (key.startsWith(`${userId}:`)) resolvedModelCache.delete(key);
  }
}

export async function appendUserLlmAudit(input: {
  userId: string;
  action: "provider_create" | "provider_update" | "provider_delete" | "preferences_update" | "connection_test" | "models_discover";
  targetId?: string;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await getSupabase().from("user_llm_config_audit").insert({
    user_id: input.userId,
    action: input.action,
    target_id: input.targetId,
    metadata: input.metadata ?? {},
  });
  if (error) console.error("记录模型配置审计失败:", error.message);
}

async function requireOwnedProvider(userId: string, providerId: string) {
  const { data, error } = await getSupabase().from("user_llm_providers")
    .select("id").eq("id", providerId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`校验 Provider 归属失败: ${error.message}`);
  if (!data) throw new Error("Provider 不存在或无权访问");
}

export async function resolveUserLlmProviderCredentials(userId: string, providerId: string) {
  const { data, error } = await getSupabase().from("user_llm_providers")
    .select("id,base_url,api_key_ciphertext,enabled")
    .eq("id", providerId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`读取 Provider 凭据失败: ${error.message}`);
  if (!data) throw new Error("Provider 不存在或无权访问");
  if (!data.enabled) throw new Error("Provider 已停用");
  return {
    baseUrl: String(data.base_url),
    apiKey: decryptRuntimeConfigValue(String(data.api_key_ciphertext)),
  };
}

function apiKeyHint(value: string) {
  const trimmed = value.trim();
  return trimmed.length <= 8
    ? `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
    : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function validateProviderName(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) throw new Error("Provider 名称长度必须为 1 到 80 个字符");
  return normalized;
}

function validateModelDraft(input: UserLlmModelDraft) {
  const modelId = input.modelId.trim();
  const displayName = input.displayName.trim();
  if (!modelId || modelId.length > 180) throw new Error("模型 ID 长度必须为 1 到 180 个字符");
  if (!displayName || displayName.length > 120) throw new Error("模型显示名称长度必须为 1 到 120 个字符");
  if (!Number.isInteger(input.contextWindow) || input.contextWindow < 4_096 || input.contextWindow > 2_000_000) {
    throw new Error(`${displayName} 的上下文窗口无效`);
  }
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 64 || input.maxOutputTokens > 131_072) {
    throw new Error(`${displayName} 的最大输出 Token 无效`);
  }
  if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
    throw new Error(`${displayName} 的温度必须在 0 到 2 之间`);
  }
  if (!(["none", "deepseek"] as string[]).includes(input.reasoningMode)) {
    throw new Error(`${displayName} 的 Reasoning 协议无效`);
  }
  return { ...input, modelId, displayName };
}

function toPublicModel(row: ModelRow, provider: ProviderRow): UserLlmModel {
  const model = {
    id: row.id,
    providerId: row.provider_id,
    providerName: provider.name,
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    supportsTools: row.supports_tools,
    supportsImages: row.supports_images,
    reasoningMode: row.reasoning_mode,
    enabled: row.enabled,
  } satisfies UserLlmModel;
  rememberModelMetadata(model.id, {
    contextWindow: model.contextWindow,
    supportsImages: model.supportsImages,
  });
  return model;
}

function toPreferences(row?: PreferenceRow | null): UserLlmPreferences {
  return row ? {
    defaultModelId: row.default_model_id,
    fastModelId: row.fast_model_id,
    visionModelId: row.vision_model_id,
  } : DEFAULT_PREFERENCES;
}

export async function listUserLlmCatalog(userId: string): Promise<UserLlmCatalog> {
  const supabase = getSupabase();
  const [{ data: providerData, error: providerError }, { data: modelData, error: modelError }, preferenceResult] = await Promise.all([
    supabase.from("user_llm_providers").select("*").eq("user_id", userId).order("updated_at", { ascending: false }),
    supabase.from("user_llm_models").select("*").eq("user_id", userId).order("updated_at", { ascending: false }),
    supabase.from("user_llm_preferences").select("default_model_id,fast_model_id,vision_model_id").eq("user_id", userId).maybeSingle(),
  ]);
  if (providerError) throw new Error(`读取模型 Provider 失败: ${providerError.message}`);
  if (modelError) throw new Error(`读取用户模型失败: ${modelError.message}`);
  if (preferenceResult.error) throw new Error(`读取模型路由失败: ${preferenceResult.error.message}`);

  const providerRows = (providerData ?? []) as ProviderRow[];
  const modelRows = (modelData ?? []) as ModelRow[];
  const providerById = new Map(providerRows.map((provider) => [provider.id, provider]));
  const models = modelRows.flatMap((row) => {
    const provider = providerById.get(row.provider_id);
    return provider ? [toPublicModel(row, provider)] : [];
  });
  const modelsByProvider = new Map<string, UserLlmModel[]>();
  for (const model of models) {
    const list = modelsByProvider.get(model.providerId) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerId, list);
  }
  const providers: UserLlmProvider[] = providerRows.map((row) => ({
    id: row.id,
    name: row.name,
    adapterType: row.adapter_type,
    baseUrl: row.base_url,
    apiKeyConfigured: Boolean(row.api_key_ciphertext),
    apiKeyHint: row.api_key_hint,
    enabled: row.enabled,
    updatedAt: row.updated_at,
    models: modelsByProvider.get(row.id) ?? [],
  }));
  return {
    providers,
    models: models.filter((model) => providerById.get(model.providerId)?.enabled),
    preferences: toPreferences(preferenceResult.data as PreferenceRow | null),
  };
}

export async function createUserLlmProvider(input: {
  userId: string;
  name: string;
  adapterType?: LlmAdapterType;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  models: UserLlmModelDraft[];
}) {
  const name = validateProviderName(input.name);
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > 4_000) throw new Error("API Key 不能为空或过长");
  if (input.models.length === 0) throw new Error("至少配置一个模型");
  const models = input.models.map(validateModelDraft);
  const supabase = getSupabase();
  const { data, error } = await supabase.from("user_llm_providers").insert({
    user_id: input.userId,
    name,
    adapter_type: input.adapterType ?? "openai-compatible",
    base_url: baseUrl,
    api_key_ciphertext: encryptRuntimeConfigValue(apiKey),
    api_key_hint: apiKeyHint(apiKey),
    enabled: input.enabled !== false,
  }).select("*").single();
  if (error || !data) throw new Error(`创建 Provider 失败: ${error?.message ?? "未返回数据"}`);
  const provider = data as ProviderRow;
  const { error: modelError } = await supabase.from("user_llm_models").insert(models.map((model) => ({
    user_id: input.userId,
    provider_id: provider.id,
    model_id: model.modelId,
    display_name: model.displayName,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    temperature: model.temperature,
    supports_tools: model.supportsTools,
    supports_images: model.supportsImages,
    reasoning_mode: model.reasoningMode,
    enabled: model.enabled,
  })));
  if (modelError) {
    await supabase.from("user_llm_providers").delete().eq("id", provider.id).eq("user_id", input.userId);
    throw new Error(`创建模型失败: ${modelError.message}`);
  }
  clearUserLlmConfigCache(input.userId);
  await appendUserLlmAudit({
    userId: input.userId,
    action: "provider_create",
    targetId: provider.id,
    metadata: { modelCount: models.length, adapterType: input.adapterType ?? "openai-compatible" },
  });
  return provider.id;
}

export async function updateUserLlmProvider(input: {
  userId: string;
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  models: UserLlmModelDraft[];
}) {
  await requireOwnedProvider(input.userId, input.providerId);
  const name = validateProviderName(input.name);
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  if (input.models.length === 0) throw new Error("至少配置一个模型");
  const models = input.models.map(validateModelDraft);
  const supabase = getSupabase();
  const providerUpdate: Record<string, unknown> = {
    name,
    base_url: baseUrl,
    enabled: input.enabled,
    updated_at: new Date().toISOString(),
  };
  if (input.apiKey?.trim()) {
    providerUpdate.api_key_ciphertext = encryptRuntimeConfigValue(input.apiKey.trim());
    providerUpdate.api_key_hint = apiKeyHint(input.apiKey.trim());
  }
  const { error } = await supabase.from("user_llm_providers")
    .update(providerUpdate).eq("id", input.providerId).eq("user_id", input.userId);
  if (error) throw new Error(`更新 Provider 失败: ${error.message}`);

  const incomingIds = models.flatMap((model) => model.id ? [model.id] : []);
  let deleteQuery = supabase.from("user_llm_models").delete()
    .eq("provider_id", input.providerId).eq("user_id", input.userId);
  if (incomingIds.length > 0) deleteQuery = deleteQuery.not("id", "in", `(${incomingIds.join(",")})`);
  const { error: deleteError } = await deleteQuery;
  if (deleteError) throw new Error(`同步模型列表失败: ${deleteError.message}`);

  for (const model of models) {
    const payload = {
      user_id: input.userId,
      provider_id: input.providerId,
      model_id: model.modelId,
      display_name: model.displayName,
      context_window: model.contextWindow,
      max_output_tokens: model.maxOutputTokens,
      temperature: model.temperature,
      supports_tools: model.supportsTools,
      supports_images: model.supportsImages,
      reasoning_mode: model.reasoningMode,
      enabled: model.enabled,
      updated_at: new Date().toISOString(),
    };
    const query = model.id
      ? supabase.from("user_llm_models").update(payload).eq("id", model.id).eq("user_id", input.userId)
      : supabase.from("user_llm_models").insert(payload);
    const { error: modelError } = await query;
    if (modelError) throw new Error(`保存模型 ${model.displayName} 失败: ${modelError.message}`);
  }
  clearUserLlmConfigCache(input.userId);
  await appendUserLlmAudit({
    userId: input.userId,
    action: "provider_update",
    targetId: input.providerId,
    metadata: { modelCount: models.length, apiKeyRotated: Boolean(input.apiKey?.trim()) },
  });
}

export async function deleteUserLlmProvider(userId: string, providerId: string) {
  await requireOwnedProvider(userId, providerId);
  const { error } = await getSupabase().from("user_llm_providers")
    .delete().eq("id", providerId).eq("user_id", userId);
  if (error) throw new Error(`删除 Provider 失败: ${error.message}`);
  clearUserLlmConfigCache(userId);
  await appendUserLlmAudit({ userId, action: "provider_delete", targetId: providerId });
}

export async function updateUserLlmPreferences(userId: string, preferences: UserLlmPreferences) {
  const ids = [preferences.defaultModelId, preferences.fastModelId, preferences.visionModelId]
    .filter((value): value is string => Boolean(value));
  if (ids.length > 0) {
    const { data, error } = await getSupabase().from("user_llm_models")
      .select("id").eq("user_id", userId).in("id", ids).eq("enabled", true);
    if (error) throw new Error(`校验模型路由失败: ${error.message}`);
    if (new Set((data ?? []).map((row: { id: string }) => row.id)).size !== new Set(ids).size) {
      throw new Error("模型路由包含无权访问或未启用的模型");
    }
  }
  const { error } = await getSupabase().from("user_llm_preferences").upsert({
    user_id: userId,
    default_model_id: preferences.defaultModelId,
    fast_model_id: preferences.fastModelId,
    vision_model_id: preferences.visionModelId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw new Error(`保存模型路由失败: ${error.message}`);
  clearUserLlmConfigCache(userId);
  await appendUserLlmAudit({
    userId,
    action: "preferences_update",
    metadata: {
      defaultModelId: preferences.defaultModelId,
      fastModelId: preferences.fastModelId,
      visionModelId: preferences.visionModelId,
    },
  });
}

export async function resolveUserLlmModel(
  userId: string,
  requestedModelId?: string | null,
  role: "default" | "fast" | "vision" = "default",
): Promise<ResolvedUserLlmModel> {
  if (requestedModelId) {
    const cached = resolvedModelCache.get(cacheKey(userId, requestedModelId));
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) resolvedModelCache.delete(cacheKey(userId, requestedModelId));
  }
  const catalog = await listUserLlmCatalog(userId);
  const preferredId = role === "fast"
    ? catalog.preferences.fastModelId
    : role === "vision"
      ? catalog.preferences.visionModelId
      : catalog.preferences.defaultModelId;
  const modelId = requestedModelId || preferredId;
  const model = modelId
    ? catalog.models.find((candidate) => candidate.id === modelId && candidate.enabled)
    : catalog.models.find((candidate) => candidate.enabled);
  if (!model) throw new Error("请先在连接 > 大语言模型中配置并启用模型");
  const provider = catalog.providers.find((candidate) =>
    candidate.id === model.providerId && candidate.enabled);
  if (!provider) throw new Error("模型所属 Provider 未启用或不存在");
  const { data, error } = await getSupabase().from("user_llm_providers")
    .select("*").eq("id", provider.id).eq("user_id", userId).single();
  if (error || !data) throw new Error("无法读取模型 Provider 密钥");
  const row = data as ProviderRow;
  const resolved = {
    ...model,
    userId,
    adapterType: row.adapter_type,
    baseUrl: row.base_url,
    apiKey: decryptRuntimeConfigValue(row.api_key_ciphertext),
  };
  resolvedModelCache.set(cacheKey(userId, model.id), {
    value: resolved,
    expiresAt: Date.now() + RESOLVED_MODEL_CACHE_TTL_MS,
  });
  return resolved;
}
