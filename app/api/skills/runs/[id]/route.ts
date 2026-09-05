import { requireUser } from "@/lib/auth/server";
import { cancelSandboxRun, getSandboxRun } from "@/lib/sandbox/client";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    return Response.json({ ok: true, run: await getSandboxRun(user.id, params.id) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "读取 Skill Run 失败" },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    await cancelSandboxRun(user.id, params.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "取消 Skill Run 失败" },
      { status: 502 },
    );
  }
}
