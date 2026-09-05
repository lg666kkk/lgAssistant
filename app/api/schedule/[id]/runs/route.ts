import { requireUser } from "@/lib/auth/server";
import { listRecentJobRuns, loadScheduledJob } from "@/lib/scheduler/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  try {
    const job = await loadScheduledJob(context.params.id);
    if (!job || job.userId !== user.id) {
      return Response.json({ ok: false, error: "任务不存在" }, { status: 404 });
    }
    const runs = await listRecentJobRuns(user.id, 100, job.id);
    return Response.json({ ok: true, job, runs }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "读取运行记录失败" },
      { status: 500 },
    );
  }
}
