import { processRagIngestionBatch } from "@/lib/knowledge/ingestion-queue";
import { isAuthorizedCronRequest } from "@/lib/scheduler/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) return new Response("forbidden", { status: 403 });
  try {
    const result = await processRagIngestionBatch({
      workerId: `cron-${crypto.randomUUID()}`,
      limit: 2,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "RAG ingestion worker failed",
    }, { status: 500 });
  }
}
