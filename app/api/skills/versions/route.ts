import { requireUser } from "@/lib/auth/server";
import { publishSkillVersion } from "@/lib/sandbox/skills";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (
    typeof body.skillId !== "string" ||
    typeof body.version !== "string" ||
    (body.runtime !== "node" && body.runtime !== "python") ||
    !Array.isArray(body.entrypoint) ||
    !body.entrypoint.every((item) => typeof item === "string") ||
    (body.profileId !== "skill-trusted" && body.profileId !== "coding-untrusted") ||
    typeof body.imageDigest !== "string" ||
    typeof body.bundleBase64 !== "string" ||
    typeof body.inputSchema !== "string" ||
    typeof body.outputSchema !== "string"
  ) {
    return Response.json({ ok: false, error: "Skill 版本配置格式错误" }, { status: 400 });
  }
  try {
    const published = await publishSkillVersion({
      skillId: body.skillId,
      version: body.version,
      runtime: body.runtime,
      entrypoint: body.entrypoint as string[],
      profileId: body.profileId,
      imageDigest: body.imageDigest,
      bundleBase64: body.bundleBase64,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
      actorId: user.id,
    });
    return Response.json({ ok: true, ...published }, { status: 201 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "发布 Skill 版本失败" },
      { status: 400 },
    );
  }
}
