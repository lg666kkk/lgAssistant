import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import type { AgentTrace } from "./trace";

export async function saveTrace(trace: AgentTrace, userId?: string): Promise<void> {
  if (!hasSupabaseConfig()) return;
  const { error } = await getSupabase()
    .from("agent_traces")
    .insert({
      request_id: trace.requestId,
      user_id: userId,
      session_id: trace.sessionId ?? null,
      stop_reason: trace.stopReason,
      completed: trace.completed,
      total_duration_ms: trace.totalDurationMs ?? null,
      steps: trace.steps,
      metrics: trace.metrics,
    });
  if (error) {
    console.error("[saveTrace] 落库失败:", error.message);
  }
}
