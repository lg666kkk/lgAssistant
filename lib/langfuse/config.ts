import { getSupabase } from "@/lib/platform/supabase";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";

export type UserLangfuseConfigView = {
  enabled: boolean;
  baseUrl: string;
  publicKeyConfigured: boolean;
  publicKeyHint: string;
  secretKeyConfigured: boolean;
  secretKeyHint: string;
  updatedAt?: string;
};

export type ResolvedLangfuseConfig = {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  secretKey: string;
};

type LangfuseRow = {
  enabled: boolean;
  base_url: string;
  public_key_ciphertext: string;
  public_key_hint: string;
  secret_key_ciphertext: string;
  secret_key_hint: string;
  updated_at: string;
};

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

function keyHint(value: string) {
  const trimmed = value.trim();
  return trimmed.length <= 10
    ? `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`
    : `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

async function readRow(userId: string): Promise<LangfuseRow | null> {
  const { data, error } = await getSupabase().from("user_langfuse_config")
    .select("enabled,base_url,public_key_ciphertext,public_key_hint,secret_key_ciphertext,secret_key_hint,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`读取 Langfuse 配置失败: ${error.message}`);
  return data as LangfuseRow | null;
}

export async function getUserLangfuseConfig(userId: string): Promise<UserLangfuseConfigView> {
  const row = await readRow(userId);
  return row ? {
    enabled: row.enabled,
    baseUrl: row.base_url,
    publicKeyConfigured: Boolean(row.public_key_ciphertext),
    publicKeyHint: row.public_key_hint,
    secretKeyConfigured: Boolean(row.secret_key_ciphertext),
    secretKeyHint: row.secret_key_hint,
    updatedAt: row.updated_at,
  } : {
    enabled: false,
    baseUrl: DEFAULT_BASE_URL,
    publicKeyConfigured: false,
    publicKeyHint: "",
    secretKeyConfigured: false,
    secretKeyHint: "",
  };
}

export async function resolveUserLangfuseConfig(userId: string): Promise<ResolvedLangfuseConfig | null> {
  const row = await readRow(userId);
  if (!row?.enabled) return null;
  if (!row.public_key_ciphertext || !row.secret_key_ciphertext) {
    throw new Error("Langfuse 已启用，但 Public Key 或 Secret Key 未配置");
  }
  return {
    enabled: true,
    baseUrl: await assertPublicProviderUrl(row.base_url),
    publicKey: decryptRuntimeConfigValue(row.public_key_ciphertext),
    secretKey: decryptRuntimeConfigValue(row.secret_key_ciphertext),
  };
}

export async function resolveUserLangfuseConfigWithOverrides(input: {
  userId: string;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
}): Promise<ResolvedLangfuseConfig> {
  const row = await readRow(input.userId);
  const baseUrl = await assertPublicProviderUrl(input.baseUrl?.trim() || row?.base_url || DEFAULT_BASE_URL);
  const publicKey = input.publicKey?.trim()
    || (row?.public_key_ciphertext ? decryptRuntimeConfigValue(row.public_key_ciphertext) : "");
  const secretKey = input.secretKey?.trim()
    || (row?.secret_key_ciphertext ? decryptRuntimeConfigValue(row.secret_key_ciphertext) : "");
  if (!publicKey || !secretKey) throw new Error("Public Key 和 Secret Key 不能为空");
  return { enabled: true, baseUrl, publicKey, secretKey };
}

export async function updateUserLangfuseConfig(input: {
  userId: string;
  enabled: boolean;
  baseUrl: string;
  publicKey?: string;
  secretKey?: string;
}) {
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const existing = await readRow(input.userId);
  const publicKey = input.publicKey?.trim();
  const secretKey = input.secretKey?.trim();
  const hasPublicKey = Boolean(publicKey || existing?.public_key_ciphertext);
  const hasSecretKey = Boolean(secretKey || existing?.secret_key_ciphertext);
  if (input.enabled && (!hasPublicKey || !hasSecretKey)) {
    throw new Error("启用 Langfuse 前必须同时配置 Public Key 和 Secret Key");
  }
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    enabled: input.enabled,
    base_url: baseUrl,
    updated_at: new Date().toISOString(),
  };
  if (publicKey) {
    payload.public_key_ciphertext = encryptRuntimeConfigValue(publicKey);
    payload.public_key_hint = keyHint(publicKey);
  } else if (!existing) {
    payload.public_key_ciphertext = "";
    payload.public_key_hint = "";
  }
  if (secretKey) {
    payload.secret_key_ciphertext = encryptRuntimeConfigValue(secretKey);
    payload.secret_key_hint = keyHint(secretKey);
  } else if (!existing) {
    payload.secret_key_ciphertext = "";
    payload.secret_key_hint = "";
  }
  const { error } = await getSupabase().from("user_langfuse_config")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw new Error(`保存 Langfuse 配置失败: ${error.message}`);
}
