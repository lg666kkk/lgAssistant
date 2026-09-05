import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/platform/supabase";

export type SandboxProfileId = "skill-trusted" | "coding-untrusted";
export type SkillRuntime = "node" | "python";

export type SkillManifest = {
  id: string;
  version: string;
  runtime: SkillRuntime;
  entrypoint: string[];
  profileId: SandboxProfileId;
  imageDigest: string;
  bundleSha256: string;
  network: "disabled";
  inputSchema: string;
  outputSchema: string;
};

export type ConfiguredSkill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  skillMd: string;
  supportFiles: Record<string, string>;
  versions: SkillManifest[];
};

export const SANDBOX_PROFILES = [
  {
    id: "skill-trusted" as const,
    label: "受信任 Skill",
    cpuQuotaMilli: 500,
    memoryLimitMb: 256,
    pidLimit: 64,
    timeoutSeconds: 30,
    network: "disabled" as const,
    imageDigest: process.env.SANDBOX_SKILL_IMAGE_DIGEST ?? "",
  },
  {
    id: "coding-untrusted" as const,
    label: "编码沙盒",
    cpuQuotaMilli: 1000,
    memoryLimitMb: 1024,
    pidLimit: 128,
    timeoutSeconds: 300,
    network: "disabled" as const,
    imageDigest: process.env.SANDBOX_CODING_IMAGE_DIGEST ?? "",
  },
];

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^v?\d+\.\d+\.\d+$/;
const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

type SkillRow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  skill_md: string;
  support_files: Record<string, string>;
};

type VersionRow = {
  skill_id: string;
  version: string;
  runtime: SkillRuntime;
  entrypoint: string[];
  profile_id: SandboxProfileId;
  image_digest: string;
  bundle_sha256: string;
  network: "disabled";
  input_schema_path: string;
  output_schema_path: string;
};

export async function listConfiguredSkills(): Promise<ConfiguredSkill[]> {
  const supabase = getSupabase();
  const [{ data: skills, error: skillError }, { data: versions, error: versionError }] = await Promise.all([
    supabase.from("sandbox_skills").select("id,name,description,enabled,skill_md,support_files,created_at,updated_at").is("deleted_at", null).order("id"),
    supabase
      .from("sandbox_skill_versions")
      .select("skill_id,version,runtime,entrypoint,profile_id,image_digest,bundle_sha256,network,input_schema_path,output_schema_path,created_at")
      .order("created_at", { ascending: false }),
  ]);
  if (skillError) throw skillDatabaseError("读取 Skill 配置", skillError.message);
  if (versionError) throw skillDatabaseError("读取 Skill 版本", versionError.message);
  const versionsBySkill = new Map<string, SkillManifest[]>();
  for (const row of (versions ?? []) as VersionRow[]) {
    const items = versionsBySkill.get(row.skill_id) ?? [];
    items.push(toManifest(row));
    versionsBySkill.set(row.skill_id, items);
  }
  return ((skills ?? []) as SkillRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    skillMd: row.skill_md ?? "",
    supportFiles: row.support_files ?? {},
    versions: versionsBySkill.get(row.id) ?? [],
  }));
}

export async function getStandardSkill(skillId: string) {
  if (!SKILL_ID.test(skillId)) throw new Error("Skill ID 格式错误");
  const { data, error } = await getSupabase()
    .from("sandbox_skills")
    .select("id,name,description,enabled,skill_md,support_files,created_at,updated_at")
    .eq("id", skillId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw skillDatabaseError("读取 Skill 内容", error.message);
  if (!data) throw new Error("Skill 不存在");
  if (!data.enabled) throw new Error("Skill 尚未启用");
  if (!data.skill_md) throw new Error("Skill 没有 SKILL.md 内容");
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    skillMd: data.skill_md,
    supportFiles: data.support_files ?? {},
  };
}

export async function upsertSkillDefinition(input: {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  actorId: string;
}) {
  const id = input.id.trim();
  const name = input.name.trim();
  const description = input.description?.trim() ?? "";
  if (!SKILL_ID.test(id)) throw new Error("Skill ID 只能包含小写字母、数字和连字符，最长 64 位");
  if (!name || name.length > 120) throw new Error("Skill 名称长度必须在 1 到 120 之间");
  if (description.length > 2000) throw new Error("Skill 描述不能超过 2000 字符");
  const { data, error } = await getSupabase().rpc("upsert_sandbox_skill", {
    p_id: id,
    p_name: name,
    p_description: description,
    p_enabled: input.enabled,
    p_actor_id: input.actorId,
  });
  if (error) throw skillDatabaseError("保存 Skill", error.message);
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved) throw new Error("这个 Skill ID 已被删除，不能复用；请使用新的 Skill ID");
  return saved;
}

export async function deleteSkillDefinition(input: { id: string; actorId: string }) {
  if (!SKILL_ID.test(input.id)) throw new Error("Skill ID 格式错误");
  const { data, error } = await getSupabase().rpc("delete_sandbox_skill", {
    p_id: input.id,
    p_actor_id: input.actorId,
  });
  if (error) {
    if (error.code === "23000" || error.message.includes("active sandbox runs")) {
      throw new Error("这个 Skill 仍有运行中或待执行的 Run，请先取消后再删除");
    }
    throw skillDatabaseError("删除 Skill", error.message);
  }
  if (!data) throw new Error("Skill 不存在或已删除");
}

export async function publishSkillVersion(input: {
  skillId: string;
  version: string;
  runtime: SkillRuntime;
  entrypoint: string[];
  profileId: SandboxProfileId;
  imageDigest: string;
  bundleBase64: string;
  inputSchema: string;
  outputSchema: string;
  actorId: string;
}) {
  const skillId = input.skillId.trim();
  const version = input.version.trim();
  const entrypoint = input.entrypoint.map((item) => item.trim()).filter(Boolean);
  const imageDigest = input.imageDigest.trim();
  const inputSchema = input.inputSchema.trim();
  const outputSchema = input.outputSchema.trim();
  if (!SKILL_ID.test(skillId)) throw new Error("Skill ID 格式错误");
  if (!VERSION.test(version)) throw new Error("版本必须使用语义化版本，例如 1.0.0");
  if (input.runtime !== "node" && input.runtime !== "python") throw new Error("运行时必须是 node 或 python");
  if (entrypoint.length < 2 || entrypoint.length > 16) throw new Error("入口命令必须包含运行时和脚本路径");
  const expectedRuntime = input.runtime === "node" ? "node" : "python3";
  if (entrypoint[0] !== expectedRuntime || !RELATIVE_PATH.test(entrypoint[1])) {
    throw new Error(`入口必须以 ${expectedRuntime} 加 Bundle 内相对脚本路径开头`);
  }
  if (!SANDBOX_PROFILES.some((profile) => profile.id === input.profileId)) throw new Error("未知 Sandbox Profile");
  if (!IMAGE_DIGEST.test(imageDigest)) throw new Error("容器镜像必须使用完整 sha256 digest");
  const configuredProfile = SANDBOX_PROFILES.find((profile) => profile.id === input.profileId);
  if (!configuredProfile?.imageDigest) throw new Error("所选 Sandbox Profile 尚未配置镜像 digest");
  if (configuredProfile.imageDigest !== imageDigest) throw new Error("镜像 digest 与所选 Sandbox Profile 不一致");
  if (!RELATIVE_PATH.test(inputSchema) || !RELATIVE_PATH.test(outputSchema)) {
    throw new Error("输入和输出 Schema 必须是 Bundle 内相对路径");
  }
  const maxBase64Length = Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 + 4;
  if (input.bundleBase64.length > maxBase64Length || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.bundleBase64)) {
    throw new Error("Skill Bundle Base64 格式错误或超过 10MiB");
  }
  const bundle = Buffer.from(input.bundleBase64, "base64");
  if (bundle.length < 1 || bundle.length > MAX_BUNDLE_BYTES) throw new Error("Skill Bundle 必须在 1B 到 10MiB 之间");
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const { data, error } = await getSupabase().rpc("publish_sandbox_skill_version", {
    p_skill_id: skillId,
    p_version: version,
    p_runtime: input.runtime,
    p_entrypoint: entrypoint,
    p_profile_id: input.profileId,
    p_image_digest: imageDigest,
    p_bundle_sha256: bundleSha256,
    p_bundle_base64: input.bundleBase64,
    p_input_schema_path: inputSchema,
    p_output_schema_path: outputSchema,
    p_actor_id: input.actorId,
  });
  if (error) {
    if (error.code === "23505") throw new Error("这个 Skill 版本已经发布，发布版本不可覆盖");
    throw skillDatabaseError("发布 Skill 版本", error.message);
  }
  return { version: data, bundleSha256 };
}

function toManifest(row: VersionRow): SkillManifest {
  return {
    id: row.skill_id,
    version: row.version,
    runtime: row.runtime,
    entrypoint: row.entrypoint,
    profileId: row.profile_id,
    imageDigest: row.image_digest,
    bundleSha256: row.bundle_sha256,
    network: row.network,
    inputSchema: row.input_schema_path,
    outputSchema: row.output_schema_path,
  };
}

function skillDatabaseError(action: string, message: string) {
  if (message.includes("deleted_at") || message.includes("delete_sandbox_skill")) {
    return new Error(`${action}失败，请先执行 20260905-skill-list-detail.sql`);
  }
  if (message.includes("sandbox_skills") || message.includes("sandbox_skill_versions")) {
    return new Error(`${action}失败，请先执行 20260904-sandbox-runtime.sql`);
  }
  return new Error(`${action}失败: ${message}`);
}
