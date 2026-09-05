import { requireUser } from "@/lib/auth/server";
import { deliverDueNotifications } from "@/lib/scheduler/deliveries";
import { claimScheduledJobNow } from "@/lib/scheduler/store";
import { executeClaimedScheduledJob } from "@/lib/scheduler/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: { id: string } }) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const workerId = `manual-${crypto.randomUUID()}`;
  const now = Date.now();
  try {
    const job = await claimScheduledJobNow({
      jobId: context.params.id,
      userId: user.id,
      workerId,
      now,
    });
    if (!job) {
      return Response.json(
        { ok: false, error: "任务不存在或正在执行" },
        { status: 409 },
      );
    }
    const status = await executeClaimedScheduledJob({ job, workerId, now, trigger: "manual" });
    const deliveries = await deliverDueNotifications({ workerId, now: Date.now() });
    return Response.json({
      ok: status === "success",
      status,
      deliveries,
      error: status === "success" ? undefined : "任务执行失败，请查看运行记录",
    }, {
      status: status === "success" ? 200 : 500,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "立即运行失败" },
      { status: 500 },
    );
  }
}
