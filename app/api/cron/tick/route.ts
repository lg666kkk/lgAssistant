import { tick } from "@/lib/scheduler/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorizedCronRequest(req: Request): boolean {
  const url = new URL(req.url);
  const configuredSecret = process.env.CRON_SECRET;
  const providedSecret =
    req.headers.get("x-cron-secret") ?? url.searchParams.get("secret");

  if (configuredSecret && providedSecret === configuredSecret) {
    return true;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    req.headers.get("x-scheduler-dev") === "1"
  ) {
    return true;
  }

  const userAgent = req.headers.get("user-agent") ?? "";
  return userAgent.includes("vercel-cron/1.0");
}

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
