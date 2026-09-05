import { createHash, randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth/server";
import { createSkillRun } from "@/lib/sandbox/client";

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
  if (typeof body.skillId !== "string" || typeof body.skillVersion !== "string" || body.input === undefined) {
    return Response.json({ ok: false, error: "skillId、skillVersion 和 input 为必填项" }, { status: 400 });
  }
  const runId = `skill-${randomUUID()}`;
  const stableInput = JSON.stringify(body.input);
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : createHash("sha256").update(`${user.id}:${runId}:${body.skillId}:${body.skillVersion}:${stableInput}`).digest("hex");
  try {
    const run = await createSkillRun({
      userId: user.id,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      toolCallId: typeof body.toolCallId === "string" ? body.toolCallId : undefined,
      runId,
      idempotencyKey,
      skillId: body.skillId,
      skillVersion: body.skillVersion,
      skillInput: body.input,
    });
    return Response.json({ ok: true, run }, { status: 202 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "创建 Skill Run 失败" },
      { status: 502 },
    );
  }
}
