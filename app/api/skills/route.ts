import { requireUser } from "@/lib/auth/server";
import {
  listConfiguredSkills,
  deleteSkillDefinition,
  SANDBOX_PROFILES,
  upsertSkillDefinition,
} from "@/lib/sandbox/skills";
import { importStandardSkill } from "@/lib/sandbox/standard-skill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const skills = await listConfiguredSkills();
    return Response.json({
      ok: true,
      canEdit: true,
      profiles: SANDBOX_PROFILES,
      skills,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "读取 Skill 配置失败" },
      { status: 503 },
    );
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    const imported = await importStandardSkill({ files, actorId: user.id });
    return Response.json({ ok: true, skill: imported }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "导入 Skill 失败" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  try {
    await deleteSkillDefinition({ id, actorId: user.id });
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除 Skill 失败";
    return Response.json({ ok: false, error: message }, {
      status: message.includes("运行中") || message.includes("待执行") ? 409 : 400,
    });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (typeof body.id !== "string" || typeof body.name !== "string" || typeof body.enabled !== "boolean") {
    return Response.json({ ok: false, error: "Skill ID、名称和启用状态格式错误" }, { status: 400 });
  }
  try {
    const existing = await listConfiguredSkills();
    if (!existing.some((skill) => skill.id === body.id)) {
      return Response.json({ ok: false, error: "请通过上传标准 SKILL.md 导入新 Skill" }, { status: 400 });
    }
    const skill = await upsertSkillDefinition({
      id: body.id,
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      enabled: body.enabled,
      actorId: user.id,
    });
    return Response.json({ ok: true, skill });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "保存 Skill 失败" },
      { status: 400 },
    );
  }
}
