import { getSupabase } from "@/lib/platform/supabase";
import { decryptRuntimeConfigValue, encryptRuntimeConfigValue } from "@/lib/runtime-config/service";
import type {
  ResolvedSearchProvider,
  SearchProviderId,
  UserSearchCatalog,
  UserSearchProvider,
} from "./types";

type ProviderRow = {
  provider: SearchProviderId;
  api_key_ciphertext: string;
  api_key_hint: string;
  enabled: boolean;
};

const PROVIDERS: Array<Omit<UserSearchProvider, "apiKeyConfigured" | "apiKeyHint" | "source" | "enabled">> = [
  {
    id: "tavily",
    name: "Tavily",
    description: "面向 Agent 和 RAG 的搜索 API，直接提供适合模型引用的网页摘要。",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  },
  {
    id: "exa",
    name: "Exa",
    description: "语义搜索和相似内容发现更强，适合研究、论文和深度资料检索。",
    docsUrl: "https://exa.ai/docs/reference/search",
  },
  {
    id: "brave",
    name: "Brave Search",
    description: "基于自有网页索引，适合通用网页、新闻和强调时效性的搜索。",
    docsUrl: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started",
  },
];

const ENV_KEYS: Record<SearchProviderId, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
};

function isProvider(value: unknown): value is SearchProviderId {
  return value === "tavily" || value === "exa" || value === "brave";
}

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return isProvider(value);
}

function apiKeyHint(value: string) {
  const trimmed = value.trim();
  return trimmed.length <= 8
    ? `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
    : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function environmentKey(provider: SearchProviderId) {
  return process.env[ENV_KEYS[provider]]?.trim() ?? "";
}

function isMissingSearchSchema(error: { code?: string; message?: string } | null | undefined) {
  return error?.code === "42P01"
    || error?.code === "PGRST205"
    || /user_search_(providers|preferences)/i.test(error?.message ?? "")
      && /does not exist|schema cache|not find/i.test(error?.message ?? "");
}

function environmentCatalog(): UserSearchCatalog {
  const configuredProvider = PROVIDERS.find((provider) => environmentKey(provider.id));
  return {
    providers: PROVIDERS.map((provider) => {
      const configured = Boolean(environmentKey(provider.id));
      return {
        ...provider,
        apiKeyConfigured: configured,
        apiKeyHint: configured ? "服务器配置" : "",
        source: configured ? "environment" as const : "unset" as const,
        enabled: configured,
      };
    }),
    defaultProvider: configuredProvider?.id ?? "tavily",
  };
}

export async function listUserSearchCatalog(userId: string): Promise<UserSearchCatalog> {
  const supabase = getSupabase();
  const [{ data, error }, preferenceResult] = await Promise.all([
    supabase.from("user_search_providers")
      .select("provider,api_key_ciphertext,api_key_hint,enabled")
      .eq("user_id", userId),
    supabase.from("user_search_preferences")
      .select("default_provider")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (isMissingSearchSchema(error) || isMissingSearchSchema(preferenceResult.error)) {
    return environmentCatalog();
  }
  if (error) throw new Error(`读取搜索引擎配置失败: ${error.message}`);
  if (preferenceResult.error) throw new Error(`读取默认搜索引擎失败: ${preferenceResult.error.message}`);
  const rows = new Map(((data ?? []) as ProviderRow[]).map((row) => [row.provider, row]));
  const providers = PROVIDERS.map((provider) => {
    const row = rows.get(provider.id);
    const envKey = environmentKey(provider.id);
    return {
      ...provider,
      apiKeyConfigured: Boolean(row?.api_key_ciphertext || envKey),
      apiKeyHint: row?.api_key_hint || (envKey ? "服务器配置" : ""),
      source: row?.api_key_ciphertext ? "database" as const : envKey ? "environment" as const : "unset" as const,
      enabled: row ? row.enabled : Boolean(envKey),
    };
  });
  const preferred = preferenceResult.data?.default_provider;
  const fallbackProvider = providers.find((provider) => provider.enabled && provider.apiKeyConfigured)?.id;
  const defaultProvider = isProvider(preferred) ? preferred : fallbackProvider ?? "tavily";
  return { providers, defaultProvider };
}

export async function updateUserSearchCatalog(input: {
  userId: string;
  defaultProvider: SearchProviderId;
  providers: Array<{ id: SearchProviderId; apiKey?: string; enabled: boolean }>;
}) {
  if (!isProvider(input.defaultProvider)) throw new Error("默认搜索引擎无效");
  const supabase = getSupabase();
  for (const provider of input.providers) {
    if (!isProvider(provider.id)) throw new Error("搜索引擎类型无效");
    const apiKey = provider.apiKey?.trim();
    if (apiKey && apiKey.length > 4_000) throw new Error(`${provider.id} API Key 过长`);
    const existing = await supabase.from("user_search_providers")
      .select("api_key_ciphertext")
      .eq("user_id", input.userId)
      .eq("provider", provider.id)
      .maybeSingle();
    if (existing.error) throw new Error(`读取 ${provider.id} 配置失败: ${existing.error.message}`);
    const hasCredential = Boolean(apiKey || existing.data?.api_key_ciphertext || environmentKey(provider.id));
    if (provider.enabled && !hasCredential) throw new Error(`${provider.id} 启用前必须配置 API Key`);
    const payload: Record<string, unknown> = {
      user_id: input.userId,
      provider: provider.id,
      enabled: provider.enabled,
      updated_at: new Date().toISOString(),
    };
    if (apiKey) {
      payload.api_key_ciphertext = encryptRuntimeConfigValue(apiKey);
      payload.api_key_hint = apiKeyHint(apiKey);
    } else if (!existing.data?.api_key_ciphertext) {
      payload.api_key_ciphertext = "";
      payload.api_key_hint = "";
    }
    const { error } = await supabase.from("user_search_providers")
      .upsert(payload, { onConflict: "user_id,provider" });
    if (error) throw new Error(`保存 ${provider.id} 配置失败: ${error.message}`);
  }
  const selected = input.providers.find((provider) => provider.id === input.defaultProvider);
  if (!selected?.enabled) throw new Error("默认搜索引擎必须启用");
  const { error } = await supabase.from("user_search_preferences").upsert({
    user_id: input.userId,
    default_provider: input.defaultProvider,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw new Error(`保存默认搜索引擎失败: ${error.message}`);
}

export async function resolveUserSearchProvider(userId?: string): Promise<ResolvedSearchProvider> {
  if (userId) {
    try {
      const catalog = await listUserSearchCatalog(userId);
      const preferred = catalog.providers.find((provider) =>
        provider.id === catalog.defaultProvider && provider.enabled && provider.apiKeyConfigured)
        ?? catalog.providers.find((provider) => provider.enabled && provider.apiKeyConfigured);
      if (preferred) {
        const { data, error } = await getSupabase().from("user_search_providers")
          .select("api_key_ciphertext")
          .eq("user_id", userId)
          .eq("provider", preferred.id)
          .maybeSingle();
        if (isMissingSearchSchema(error)) {
          const fallback = environmentKey(preferred.id);
          if (fallback) return { id: preferred.id, apiKey: fallback };
        }
        if (error) throw new Error(`读取搜索引擎密钥失败: ${error.message}`);
        const ciphertext = data?.api_key_ciphertext;
        const apiKey = ciphertext ? decryptRuntimeConfigValue(String(ciphertext)) : environmentKey(preferred.id);
        if (apiKey) return { id: preferred.id, apiKey };
      }
    } catch (error) {
      throw error;
    }
  }
  for (const provider of PROVIDERS) {
    const apiKey = environmentKey(provider.id);
    if (apiKey) return { id: provider.id, apiKey };
  }
  throw new Error("请先在连接 > 搜索引擎中配置并启用搜索服务");
}

export async function resolveUserSearchProviderCredentials(input: {
  userId: string;
  provider: SearchProviderId;
  apiKey?: string;
}): Promise<ResolvedSearchProvider> {
  if (!isProvider(input.provider)) throw new Error("搜索引擎类型无效");
  const overrideApiKey = input.apiKey?.trim();
  if (overrideApiKey) {
    if (overrideApiKey.length > 4_000) throw new Error("API Key 过长");
    return { id: input.provider, apiKey: overrideApiKey };
  }

  const { data, error } = await getSupabase().from("user_search_providers")
    .select("api_key_ciphertext")
    .eq("user_id", input.userId)
    .eq("provider", input.provider)
    .maybeSingle();
  if (isMissingSearchSchema(error)) {
    const fallback = environmentKey(input.provider);
    if (fallback) return { id: input.provider, apiKey: fallback };
    throw new Error("请先执行搜索引擎配置迁移并填写 API Key");
  }
  if (error) throw new Error(`读取搜索引擎密钥失败: ${error.message}`);
  const ciphertext = data?.api_key_ciphertext;
  const apiKey = ciphertext
    ? decryptRuntimeConfigValue(String(ciphertext))
    : environmentKey(input.provider);
  if (!apiKey) throw new Error("请先填写并保存 API Key，或在输入框中填写后直接测试");
  return { id: input.provider, apiKey };
}
