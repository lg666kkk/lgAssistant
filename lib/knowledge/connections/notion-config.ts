import { getSupabase } from "@/lib/platform/supabase";
import {
  decryptRuntimeConfigValue,
  encryptRuntimeConfigValue,
} from "@/lib/runtime-config/service";
import type {
  ResolvedUserNotionConnection,
  UserNotionConnectionView,
} from "./types";

const PROVIDER = "notion";
const DEFAULT_MAX_DEPTH = 8;

type NotionConnectionRow = {
  enabled: boolean;
  credentials_ciphertext: string;
  credentials_hint: string;
  settings: {
    defaultRecursive?: boolean;
    maxDepth?: number;
  } | null;
  revision: number;
  last_test_status: "success" | "failed" | null;
  last_test_error: string | null;
  last_tested_at: string | null;
  updated_at: string;
};

function tokenHint(token: string) {
  const trimmed = token.trim();
  return trimmed.length <= 12
    ? `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`
    : `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function boundedDepth(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error("Notion 递归深度必须是 1 到 16 的整数");
  }
  return value;
}

function isMissingTable(error: { code?: string; message?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

async function readRow(userId: string): Promise<NotionConnectionRow | null> {
  const { data, error } = await getSupabase()
    .from("user_knowledge_connections")
    .select("enabled,credentials_ciphertext,credentials_hint,settings,revision,last_test_status,last_test_error,last_tested_at,updated_at")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      throw new Error("知识库连接数据表尚未创建，请先执行 20260829-user-knowledge-connections.sql");
    }
    throw new Error(`读取 Notion 配置失败: ${error.message}`);
  }
  return data as NotionConnectionRow | null;
}

function settingsFromRow(row: NotionConnectionRow | null) {
  return {
    defaultRecursive: row?.settings?.defaultRecursive !== false,
    maxDepth: Number.isInteger(row?.settings?.maxDepth)
      ? boundedDepth(row!.settings!.maxDepth!)
      : DEFAULT_MAX_DEPTH,
  };
}

export async function getUserNotionConnection(userId: string): Promise<UserNotionConnectionView> {
  const row = await readRow(userId);
  const settings = settingsFromRow(row);
  return {
    enabled: row?.enabled ?? false,
    tokenConfigured: Boolean(row?.credentials_ciphertext),
    tokenHint: row?.credentials_hint ?? "",
    ...settings,
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at,
    lastTestStatus: row?.last_test_status ?? undefined,
    lastTestError: row?.last_test_error ?? undefined,
    lastTestedAt: row?.last_tested_at ?? undefined,
  };
}

export async function resolveUserNotionConnection(
  userId: string,
): Promise<ResolvedUserNotionConnection> {
  const row = await readRow(userId);
  if (!row?.enabled) throw new Error("当前用户尚未启用 Notion 连接");
  if (!row.credentials_ciphertext) throw new Error("Notion 已启用，但 Integration Token 未配置");
  return {
    enabled: true,
    token: decryptRuntimeConfigValue(row.credentials_ciphertext),
    ...settingsFromRow(row),
    revision: row.revision,
  };
}

export async function resolveUserNotionTokenWithOverride(input: {
  userId: string;
  token?: string;
}) {
  const token = input.token?.trim();
  if (token) return token;
  const row = await readRow(input.userId);
  if (!row?.credentials_ciphertext) throw new Error("请先输入或保存 Notion Integration Token");
  return decryptRuntimeConfigValue(row.credentials_ciphertext);
}

export async function updateUserNotionConnection(input: {
  userId: string;
  enabled: boolean;
  token?: string;
  defaultRecursive: boolean;
  maxDepth: number;
}) {
  const existing = await readRow(input.userId);
  const token = input.token?.trim();
  if (token && (token.length < 20 || token.length > 500)) {
    throw new Error("Notion Integration Token 长度无效");
  }
  if (input.enabled && !token && !existing?.credentials_ciphertext) {
    throw new Error("启用 Notion 前必须配置 Integration Token");
  }
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    provider: PROVIDER,
    enabled: input.enabled,
    settings: {
      defaultRecursive: input.defaultRecursive,
      maxDepth: boundedDepth(input.maxDepth),
    },
    revision: (existing?.revision ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (token) {
    payload.credentials_ciphertext = encryptRuntimeConfigValue(token);
    payload.credentials_hint = tokenHint(token);
  } else if (!existing) {
    payload.credentials_ciphertext = "";
    payload.credentials_hint = "";
  }
  const { error } = await getSupabase()
    .from("user_knowledge_connections")
    .upsert(payload, { onConflict: "user_id,provider" });
  if (error) throw new Error(`保存 Notion 配置失败: ${error.message}`);
  return getUserNotionConnection(input.userId);
}

export async function recordNotionConnectionTest(input: {
  userId: string;
  ok: boolean;
  error?: string;
}) {
  const row = await readRow(input.userId);
  if (!row) return;
  const { error } = await getSupabase()
    .from("user_knowledge_connections")
    .update({
      last_test_status: input.ok ? "success" : "failed",
      last_test_error: input.error?.slice(0, 500) ?? null,
      last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", input.userId)
    .eq("provider", PROVIDER);
  if (error) throw new Error(`记录 Notion 连接测试失败: ${error.message}`);
}
