import { getSupabase } from "@/lib/platform/supabase";
import { decryptRuntimeConfigValue, encryptRuntimeConfigValue } from "@/lib/runtime-config/service";
import { assertPublicProviderUrl } from "@/lib/llm/url-safety";
import type { JevConfigView, ResolvedJevConfig } from "./types";

const TABLE = "user_jev_configs";
const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";

type Row = {
  user_id: string;
  base_url: string;
  api_key_ciphertext: string;
  api_key_hint: string;
  model_id: string;
  last_tested_at: string | null;
  last_test_status: "ok" | "error" | null;
  last_test_latency_ms: number | null;
  updated_at: string;
};

function missingSchema(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "42P01" || value?.code === "PGRST205" || value?.message?.includes(TABLE) === true;
}

function schemaError() {
  return new Error("尚未创建 Jev 配置表，请先执行 20260923-user-jev-config.sql");
}

function hint(value: string) {
  const text = value.trim();
  return text.length <= 8 ? `${text.slice(0, 2)}...${text.slice(-2)}` : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function readRow(userId: string) {
  const { data, error } = await getSupabase().from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  if (missingSchema(error)) throw schemaError();
  if (error) throw new Error(`读取 Jev 配置失败: ${error.message}`);
  return data as Row | null;
}

export async function getUserJevConfigView(userId: string): Promise<JevConfigView> {
  const row = await readRow(userId);
  return {
    baseUrl: row?.base_url ?? DEFAULT_BASE_URL,
    apiKeyConfigured: Boolean(row?.api_key_ciphertext),
    apiKeyHint: row?.api_key_hint ?? "",
    modelId: row?.model_id ?? DEFAULT_MODEL,
    lastTestedAt: row?.last_tested_at ?? undefined,
    lastTestStatus: row?.last_test_status ?? undefined,
    lastTestLatencyMs: row?.last_test_latency_ms ?? undefined,
    updatedAt: row?.updated_at,
  };
}

export async function saveUserJevConfig(input: { userId: string; baseUrl: string; apiKey?: string; modelId: string }) {
  const baseUrl = await assertPublicProviderUrl(input.baseUrl);
  const modelId = input.modelId.trim();
  if (!/^jev-[a-z0-9.-]+$/i.test(modelId) || modelId.length > 120) throw new Error("Jev 模型 ID 无效");
  const apiKey = input.apiKey?.trim() ?? "";
  if (apiKey.length > 4_000) throw new Error("API Key 过长");
  const existing = await readRow(input.userId);
  if (!apiKey && !existing?.api_key_ciphertext) throw new Error("首次配置必须填写 API Key");
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    base_url: baseUrl,
    model_id: modelId,
    updated_at: new Date().toISOString(),
  };
  if (apiKey) {
    payload.api_key_ciphertext = encryptRuntimeConfigValue(apiKey);
    payload.api_key_hint = hint(apiKey);
  } else if (existing) {
    payload.api_key_ciphertext = existing.api_key_ciphertext;
    payload.api_key_hint = existing.api_key_hint;
  }
  const { error } = await getSupabase().from(TABLE).upsert(payload, { onConflict: "user_id" });
  if (missingSchema(error)) throw schemaError();
  if (error) throw new Error(`保存 Jev 配置失败: ${error.message}`);
  await appendJevAudit(input.userId, "config_update", { modelId, apiKeyRotated: Boolean(apiKey) });
}

export async function resolveUserJevConfig(userId: string): Promise<ResolvedJevConfig> {
  const row = await readRow(userId);
  if (!row?.api_key_ciphertext) throw new Error("请先在连接 > Jev 中配置 API Key");
  return {
    ...(await getUserJevConfigView(userId)),
    userId,
    apiKey: decryptRuntimeConfigValue(row.api_key_ciphertext),
    baseUrl: row.base_url,
    modelId: row.model_id,
  };
}

export async function recordJevConnectionTest(input: { userId: string; status: "ok" | "error"; latencyMs?: number; error?: string }) {
  const now = new Date().toISOString();
  const { error } = await getSupabase().from(TABLE).update({
    last_tested_at: now,
    last_test_status: input.status,
    last_test_latency_ms: input.latencyMs ?? null,
    updated_at: now,
  }).eq("user_id", input.userId);
  if (error && !missingSchema(error)) console.error("记录 Jev 连接测试失败:", error.message);
  await appendJevAudit(input.userId, "connection_test", { status: input.status, latencyMs: input.latencyMs, error: input.error?.slice(0, 300) });
}

async function appendJevAudit(userId: string, action: "config_update" | "connection_test", metadata: Record<string, unknown>) {
  const { error } = await getSupabase().from("user_jev_config_audit").insert({ user_id: userId, action, metadata });
  if (error && !missingSchema(error)) console.error("记录 Jev 配置审计失败:", error.message);
}
