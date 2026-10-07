import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { requireUser } from "@/lib/auth/server";
import { importStandardSkill } from "@/lib/sandbox/standard-skill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const execFileAsync = promisify(execFile);
const SOURCE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:@[A-Za-z0-9_.-]+)?$/;
const MAX_FILES = 128;
const MAX_BYTES = 10 * 1024 * 1024;

function safeSource(value: unknown) {
  if (typeof value !== "string") throw new Error("package 必须是 owner/repo 或 owner/repo@skill");
  const source = value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!SOURCE.test(source)) throw new Error("只允许 GitHub owner/repo 或 owner/repo@skill 来源");
  return source;
}

async function collect(root: string) {
  const found: string[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) throw new Error("Skill 安装包不能包含符号链接");
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "SKILL.md") found.push(full);
      if (found.length > MAX_FILES) throw new Error("安装包包含过多 Skill");
    }
  }
  await walk(root); return found;
}

export async function POST(req: Request) {
  const user = await requireUser(req); if (user instanceof Response) return user;
  let source: string;
  try { source = safeSource((await req.json()).package); } catch (e) { return Response.json({ok:false,error:e instanceof Error?e.message:"安装参数错误"},{status:400}); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-skill-install-"));
  try {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ private: true, name: "personal-assistant-skill-install" }));
    await execFileAsync("npx", ["--yes", "skills", "add", source, "--copy", "-y"], { cwd: dir, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, CI: "1" } });
    const skillPaths = await collect(dir); if (!skillPaths.length) throw new Error("安装结果中没有找到 SKILL.md");
    const imported = [];
    let total = 0;
    for (const skillPath of skillPaths) {
      const skillRoot = path.dirname(skillPath); const files: File[] = [];
      const addFiles = async (folder: string): Promise<void> => { for (const entry of await fs.readdir(folder,{withFileTypes:true})) { if(entry.isSymbolicLink()) throw new Error("Skill 安装包不能包含符号链接"); const full=path.join(folder,entry.name); if(entry.isDirectory()) await addFiles(full); else { const data=await fs.readFile(full); total += data.byteLength; if(total>MAX_BYTES) throw new Error("安装内容超过 10MiB"); const rel=path.relative(skillRoot,full); files.push(new File([data], rel)); } } };
      await addFiles(skillRoot); imported.push(await importStandardSkill({ files, actorId: user.id }));
    }
    return Response.json({ok:true,skills:imported},{status:201});
  } catch (error) { return Response.json({ok:false,error:error instanceof Error?error.message:"安装 Skill 失败"},{status:400}); }
  finally { await fs.rm(dir,{recursive:true,force:true}).catch(()=>{}); }
}
