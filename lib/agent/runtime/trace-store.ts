import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import {
  redactSensitiveValue,
  traceRetentionUntil,
} from "@/lib/agent/rag/governance";
import type { AgentTrace } from "./trace";

export async function saveTrace(trace: AgentTrace, userId?: string): Promise<void> {
  if (!hasSupabaseConfig()) return;
  const supabase = getSupabase();
  const payload = {
    request_id: trace.requestId,
    user_id: userId,
    session_id: trace.sessionId ?? null,
    stop_reason: trace.stopReason,
    completed: trace.completed,
    total_duration_ms: trace.totalDurationMs ?? null,
    steps: redactSensitiveValue(trace.steps),
    metrics: redactSensitiveValue(trace.metrics),
  };
  let { error } = await supabase
    .from("agent_traces")
    .insert({
      ...payload,
      retention_until: traceRetentionUntil(),
    });
  if (error && isMissingRetentionColumn(error)) {
    ({ error } = await supabase.from("agent_traces").insert(payload));
  }
  if (error) {
    console.error("[saveTrace] 落库失败:", error.message);
  }
}

function isMissingRetentionColumn(error: { code?: string; message?: string }) {
  return error.code === "PGRST204"
    || error.message?.includes("retention_until") === true
    || error.message?.includes("schema cache") === true;
}
