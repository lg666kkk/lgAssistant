import { getSupabase } from "@/lib/platform/supabase";
import { decryptRuntimeConfigValue, encryptRuntimeConfigValue } from "@/lib/runtime-config/service";

const TABLE = "user_sandbox_configs";

type SandboxConfigRow = {
  user_id: string;
  api_key_ciphertext: string;
  api_key_hint: string;
  last_tested_at: string | null;
  last_test_status: "ok" | "error" | null;
  last_test_latency_ms: number | null;
  updated_at: string;
};

export type SandboxConfigView = {
  configured: boolean;
  hint: string;
  source: "user" | "environment" | "unset";
  lastTestedAt?: string;
  lastTestStatus?: "ok" | "error";
  lastTestLatencyMs?: number;
  updatedAt?: string;
};

function missingSchema(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "42P01" || value?.code === "PGRST205" || value?.message?.includes(TABLE) === true;
}

function hint(value: string) {
  return `••••${value.slice(-4)}`;
}

async function readRow(userId: string): Promise<SandboxConfigRow | null> {
  const { data, error } = await getSupabase().from(TABLE).select("*").eq("user_id", userId).maybeSingle();
  if (missingSchema(error)) throw new Error("尚未创建沙盒配置表，请先执行 20260928-user-sandbox-config.sql");
  if (error) throw new Error(`读取沙盒配置失败: ${error.message}`);
  return data as SandboxConfigRow | null;
}

export async function getUserSandboxConfigView(userId: string): Promise<SandboxConfigView> {
  const row = await readRow(userId);
  if (row) {
    return {
      configured: Boolean(row.api_key_ciphertext),
      hint: row.api_key_hint,
      source: "user",
      lastTestedAt: row.last_tested_at ?? undefined,
      lastTestStatus: row.last_test_status ?? undefined,
      lastTestLatencyMs: row.last_test_latency_ms ?? undefined,
      updatedAt: row.updated_at,
    };
  }
  const environmentKey = process.env.E2B_API_KEY?.trim();
  return {
    configured: Boolean(environmentKey),
    hint: environmentKey ? hint(environmentKey) : "",
    source: environmentKey ? "environment" : "unset",
  };
}

export async function getE2BApiKey(userId: string): Promise<string> {
  const row = await readRow(userId);
  const apiKey = row?.api_key_ciphertext
    ? decryptRuntimeConfigValue(row.api_key_ciphertext)
    : process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("请先在连接 > 沙盒环境中配置 E2B API Key");
  return apiKey;
}

export async function saveUserSandboxConfig(input: { userId: string; apiKey: string }): Promise<void> {
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > 4_000) throw new Error("E2B API Key 不能为空或过长");
  const supabase = getSupabase();
  const { count, error: runsError } = await supabase.from("sandbox_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .in("status", ["queued", "preparing", "running", "collecting_artifacts", "retry_wait"]);
  if (runsError) throw new Error(`检查运行中的 Skill Run 失败: ${runsError.message}`);
  if (count) throw new Error("存在未完成的 Skill Run，请结束后再更换 E2B API Key");
  const { error } = await supabase.from(TABLE).upsert({
    user_id: input.userId,
    api_key_ciphertext: encryptRuntimeConfigValue(apiKey),
    api_key_hint: hint(apiKey),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (missingSchema(error)) throw new Error("尚未创建沙盒配置表，请先执行 20260928-user-sandbox-config.sql");
  if (error) throw new Error(`保存沙盒配置失败: ${error.message}`);
  await appendAudit(input.userId, "config_update", {}).catch((auditError) => {
    console.error("记录沙盒配置审计失败:", auditError);
  });
}

export async function recordSandboxConnectionTest(input: {
  userId: string;
  status: "ok" | "error";
  latencyMs?: number;
}): Promise<void> {
  const { error } = await getSupabase().from(TABLE).update({
    last_tested_at: new Date().toISOString(),
    last_test_status: input.status,
    last_test_latency_ms: input.latencyMs ?? null,
  }).eq("user_id", input.userId);
  if (error && !missingSchema(error)) throw new Error(`记录沙盒连接测试失败: ${error.message}`);
  await appendAudit(input.userId, "connection_test", { status: input.status, latencyMs: input.latencyMs });
}

async function appendAudit(userId: string, action: "config_update" | "connection_test", metadata: Record<string, unknown>) {
  const { error } = await getSupabase().from("user_sandbox_config_audit").insert({ user_id: userId, action, metadata });
  if (error && !missingSchema(error)) throw new Error(`记录沙盒配置审计失败: ${error.message}`);
}
