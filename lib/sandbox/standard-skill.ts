import { createHash } from "node:crypto";
import { getSupabase } from "@/lib/platform/supabase";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function metadata(markdown: string, key: string) {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((item) => item.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "") : "";
}

function relativePath(file: File) {
  const directoryPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  // Browser folder uploads include their selected root; CLI imports already use relative names.
  return directoryPath ? directoryPath.slice(directoryPath.indexOf("/") + 1) : file.name;
}

export async function importStandardSkill(input: { files: File[]; actorId: string }) {
  if (!input.actorId) throw new Error("导入 Skill 需要用户身份");
  if (input.files.length === 0) throw new Error("请选择包含 SKILL.md 的技能目录");
  let total = 0;
  const contents = new Map<string, string>();
  for (const file of input.files) {
    const path = relativePath(file);
    if (!path || path.includes("\\") || path.startsWith("/") || path.includes("..") || path === ".git" || path.startsWith(".git/")) {
      throw new Error("技能文件包含不安全路径");
    }
    if (file.size > MAX_FILE_BYTES) throw new Error(`文件 ${path} 超过 2MiB`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("技能目录不能超过 10MiB");
    if (contents.has(path)) throw new Error(`技能目录包含重复路径：${path}`);
    contents.set(path, await file.text());
  }
  const skillMd = contents.get("SKILL.md");
  if (!skillMd) throw new Error("技能目录根部必须包含 SKILL.md");
  const name = metadata(skillMd, "name");
  const description = metadata(skillMd, "description");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  if (!ID.test(id)) throw new Error("SKILL.md 的 name 无法生成合法 Skill ID");
  const supportFiles = Object.fromEntries(Array.from(contents).filter(([path]) => path !== "SKILL.md"));
  const database = getSupabase();
  // Keep the original ID for a creator's existing installations. New IDs contain
  // a user-specific digest so two users can independently import the same name.
  const scopedId = `${id.slice(0, 31)}-${createHash("sha256").update(JSON.stringify([input.actorId, id])).digest("hex").slice(0, 32)}`;
  const { data: existing, error: readError } = await database.from("sandbox_skills")
    .select("id").eq("created_by", input.actorId).in("id", [id, scopedId]).maybeSingle();
  if (readError) throw new Error(`读取 Skill 失败：${readError.message}`);
  const values = {
    name, description, enabled: false, skill_md: skillMd,
    support_files: supportFiles, updated_by: input.actorId,
    deleted_at: null, deleted_by: null, updated_at: new Date().toISOString(),
  };
  const query = existing
    ? database.from("sandbox_skills").update(values).eq("id", existing.id).eq("created_by", input.actorId)
    : database.from("sandbox_skills").insert({ ...values, id: scopedId, created_by: input.actorId });
  const { data, error } = await query.select("id,name,description,enabled,skill_md,support_files,created_at,updated_at").single();
  if (error) throw new Error(`保存 Skill 失败：${error.message}`);
  return data;
}
