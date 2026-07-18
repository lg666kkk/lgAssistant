import { enqueueKnowledgeProfileRefresh } from "@/lib/agent/tools/knowledge-profile";
import { redactSensitiveText } from "@/lib/agent/rag/governance";
import { getSupabase } from "@/lib/platform/supabase";
import { syncNotionPageTree, syncNotionPages } from "./sync";

export type RagIngestionJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "completed"
  | "dead"
  | "cancelled";

export type RagIngestionJob = {
  id: string;
  user_id: string;
  page_id: string;
  tree: boolean;
  force: boolean;
  status: RagIngestionJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_until?: string | null;
  worker_id?: string | null;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
  trace_id?: string | null;
  retention_until: string;
  created_at: string;
  updated_at: string;
};

export async function enqueueRagIngestionJob(input: {
  userId: string;
  pageId: string;
  tree?: boolean;
  force?: boolean;
  traceId?: string;
  maxAttempts?: number;
}): Promise<RagIngestionJob> {
  const { data, error } = await getSupabase().rpc("enqueue_rag_ingestion_job", {
    p_user_id: input.userId,
    p_page_id: input.pageId,
    p_tree: input.tree !== false,
    p_force: input.force === true,
    p_trace_id: input.traceId ?? null,
    p_max_attempts: Math.min(Math.max(input.maxAttempts ?? 3, 1), 8),
  });
  if (error) throw new Error(`入队 RAG ingestion 失败: ${error.message}`);
  const job = Array.isArray(data) ? data[0] : data;
  if (!job?.id) throw new Error("入队 RAG ingestion 未返回 job");
  return job as RagIngestionJob;
}

export async function claimRagIngestionJobs(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}): Promise<RagIngestionJob[]> {
  const { data, error } = await getSupabase().rpc("claim_rag_ingestion_jobs", {
    p_worker_id: input.workerId,
    p_limit: Math.min(Math.max(input.limit ?? 2, 1), 20),
    p_lease_seconds: Math.min(Math.max(input.leaseSeconds ?? 300, 30), 1_800),
  });
  if (error) throw new Error(`领取 RAG ingestion job 失败: ${error.message}`);
  return (data ?? []) as RagIngestionJob[];
}

export async function processRagIngestionBatch(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}) {
  const jobs = await claimRagIngestionJobs(input);
  const results = await Promise.all(jobs.map((job) => processJob(job, input.workerId)));
  return {
    claimed: jobs.length,
    completed: results.filter((result) => result.status === "completed").length,
    retrying: results.filter((result) => result.status === "retry_wait").length,
    dead: results.filter((result) => result.status === "dead").length,
    leaseLost: results.filter((result) => result.status === "lease_lost").length,
    results,
  };
}

export function nextIngestionFailureState(input: {
  attempts: number;
  maxAttempts: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const exhausted = input.attempts >= input.maxAttempts;
  const nextDelayMs = Math.min(
    300_000,
    5_000 * 2 ** Math.max(0, input.attempts - 1),
  );
  return {
    status: exhausted ? "dead" as const : "retry_wait" as const,
    nextAttemptAt: new Date(now.getTime() + nextDelayMs).toISOString(),
    retentionUntil: exhausted
      ? new Date(now.getTime() + 90 * 86_400_000).toISOString()
      : undefined,
  };
}

async function processJob(job: RagIngestionJob, workerId: string) {
  try {
    const syncResults = job.tree
      ? await syncNotionPageTree(job.page_id, {
          userId: job.user_id,
          force: job.force,
          maxRetries: 0,
        })
      : await syncNotionPages([job.page_id], {
          userId: job.user_id,
          force: job.force,
          maxRetries: 0,
        });
    const failures = syncResults.filter((result) => !result.success);
    if (failures.length > 0) {
      throw new Error(failures.map((result) =>
        `${result.pageId}: ${result.error ?? "同步失败"}`).join("; "));
    }

    await enqueueKnowledgeProfileRefresh({ userId: job.user_id });
    const payload = {
      pages: syncResults.length,
      chunks: syncResults.reduce((sum, result) => sum + result.chunksCount, 0),
      indexVersions: syncResults.flatMap((result) =>
        result.indexVersion ? [result.indexVersion] : []),
      results: syncResults,
    };
    const { data: completedJob, error } = await getSupabase()
      .from("rag_ingestion_jobs")
      .update({
        status: "completed",
        result: payload,
        lease_until: null,
        last_error: null,
        retention_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("worker_id", workerId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`完成 ingestion job 失败: ${error.message}`);
    if (!completedJob) throw new Error("ingestion job lease 已丢失");
    return { id: job.id, status: "completed" as const, result: payload };
  } catch (error) {
    const message = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 4_000);
    const failureState = nextIngestionFailureState({
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    });
    const status = failureState.status;
    const { data: failedJob, error: updateError } = await getSupabase()
      .from("rag_ingestion_jobs")
      .update({
        status,
        last_error: message,
        lease_until: null,
        next_attempt_at: failureState.nextAttemptAt,
        retention_until: failureState.retentionUntil ?? job.retention_until,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("worker_id", workerId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error(`记录 ingestion 失败状态失败: ${updateError.message}`);
    if (!failedJob) {
      return { id: job.id, status: "lease_lost" as const, error: message };
    }
    return { id: job.id, status, error: message };
  }
}
