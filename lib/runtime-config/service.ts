import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSupabase } from "@/lib/platform/supabase";
import {
  getRuntimeConfigDefinition,
  runtimeConfigDefinitions,
  type RuntimeConfigDefinition,
} from "./registry";

const SCOPE = "global";

type RuntimeConfigRow = {
  key: string;
  value_ciphertext: string;
  is_secret: boolean;
  updated_at: string;
};

export type RuntimeConfigView = Omit<RuntimeConfigDefinition, "environmentKey"> & {
  configured: boolean;
  value: string | null;
  source: "database" | "environment" | "unset";
  updatedAt?: string;
};

function encryptionKey() {
  const encoded = process.env.CONFIG_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new Error("缺少 CONFIG_ENCRYPTION_KEY，无法读写运行时配置");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("CONFIG_ENCRYPTION_KEY 必须是 32 字节的 Base64 值");
  }
  return key;
}

export function encryptRuntimeConfigValue(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptRuntimeConfigValue(value: string) {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("运行时配置密文格式错误");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function valueDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validateValue(definition: RuntimeConfigDefinition, value: string) {
  if (!value.trim()) throw new Error(`${definition.label} 不能为空`);
  if (value.length > 4_000) throw new Error(`${definition.label} 超过最大长度`);
  if (definition.options && !definition.options.includes(value)) {
    throw new Error(`${definition.label} 取值无效`);
  }
  if (!definition.secret && definition.key.endsWith("BASE_URL")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error();
      }
    } catch {
      throw new Error(`${definition.label} 必须是 HTTP(S) URL`);
    }
  }
}

function environmentValue(definition: RuntimeConfigDefinition) {
  return definition.environmentKey ? process.env[definition.environmentKey]?.trim() : undefined;
}

export async function listRuntimeConfig(): Promise<RuntimeConfigView[]> {
  const { data, error } = await getSupabase()
    .from("app_runtime_config")
    .select("key, value_ciphertext, is_secret, updated_at")
    .eq("scope", SCOPE);
  if (error) throw new Error(`读取运行时配置失败: ${error.message}`);

  const rows = new Map(((data ?? []) as RuntimeConfigRow[]).map((row) => [row.key, row]));
  return runtimeConfigDefinitions.map((definition) => {
    const row = rows.get(definition.key);
    if (row) {
      const value = decryptRuntimeConfigValue(row.value_ciphertext);
      return {
        key: definition.key,
        label: definition.label,
        group: definition.group,
        description: definition.description,
        secret: definition.secret,
        type: definition.type,
        options: definition.options,
        configured: Boolean(value),
        value: definition.secret ? null : value,
        source: "database" as const,
        updatedAt: row.updated_at,
      };
    }

    const value = environmentValue(definition);
    return {
      key: definition.key,
      label: definition.label,
      group: definition.group,
      description: definition.description,
      secret: definition.secret,
      type: definition.type,
      options: definition.options,
      configured: Boolean(value),
      value: definition.secret ? null : value ?? null,
      source: value ? "environment" as const : "unset" as const,
    };
  });
}

export async function upsertRuntimeConfig(input: {
  key: string;
  value: string;
  actorId: string;
}) {
  const definition = getRuntimeConfigDefinition(input.key);
  if (!definition) throw new Error("不允许修改该配置项");
  validateValue(definition, input.value);

  const supabase = getSupabase();
  const { error } = await supabase.from("app_runtime_config").upsert({
    scope: SCOPE,
    key: definition.key,
    value_ciphertext: encryptRuntimeConfigValue(input.value),
    is_secret: definition.secret,
    updated_by: input.actorId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "scope,key" });
  if (error) throw new Error(`保存运行时配置失败: ${error.message}`);

  const { error: auditError } = await supabase.from("app_runtime_config_audit").insert({
    scope: SCOPE,
    key: definition.key,
    action: "upsert",
    value_digest: valueDigest(input.value),
    actor_id: input.actorId,
  });
  if (auditError) throw new Error(`记录配置审计失败: ${auditError.message}`);
}
