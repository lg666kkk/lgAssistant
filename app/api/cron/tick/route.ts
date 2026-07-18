import { tick } from "@/lib/scheduler/tick";
import { isAuthorizedCronRequest } from "@/lib/scheduler/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const result = await tick(Date.now());
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Cron tick failed",
      },
      { status: 500 },
    );
  }
}
