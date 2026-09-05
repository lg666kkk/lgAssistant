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
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const marker = path.indexOf("/");
  return marker >= 0 ? path.slice(marker + 1) : path;
}

export async function importStandardSkill(input: { files: File[]; actorId: string }) {
  if (input.files.length === 0) throw new Error("请选择包含 SKILL.md 的技能目录");
  let total = 0;
  const contents = new Map<string, string>();
  for (const file of input.files) {
    const path = relativePath(file);
    if (!path || path.startsWith("/") || path.includes("..") || path === ".git" || path.startsWith(".git/")) {
      throw new Error("技能文件包含不安全路径");
    }
    if (file.size > MAX_FILE_BYTES) throw new Error(`文件 ${path} 超过 2MiB`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("技能目录不能超过 10MiB");
    contents.set(path, await file.text());
  }
  const skillMd = contents.get("SKILL.md");
  if (!skillMd) throw new Error("技能目录根部必须包含 SKILL.md");
  const name = metadata(skillMd, "name");
  const description = metadata(skillMd, "description");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  if (!ID.test(id)) throw new Error("SKILL.md 的 name 无法生成合法 Skill ID");
  const supportFiles = Object.fromEntries(Array.from(contents).filter(([path]) => path !== "SKILL.md"));
  const { data, error } = await getSupabase().from("sandbox_skills").upsert({
    id, name: name || id, description, enabled: false, skill_md: skillMd,
    support_files: supportFiles, updated_by: input.actorId, created_by: input.actorId,
  }, { onConflict: "id" }).select("id,name,description,enabled,skill_md,support_files,created_at,updated_at").single();
  if (error) throw new Error(`保存 Skill 失败：${error.message}`);
  return data;
}
