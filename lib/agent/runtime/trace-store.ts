import { getSupabase, hasSupabaseConfig } from "@/lib/platform/supabase";
import {
  redactSensitiveValue,
  traceRetentionUntil,
} from "@/lib/agent/rag/governance";
import type { AgentTrace, MemoryConsolidationTraceStep, TraceStep } from "./trace";

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

const APPEND_RETRY_DELAYS_MS = [0, 50, 150, 300];

export function mergeMemoryConsolidationTraceStep(
  currentSteps: TraceStep[],
  step: Omit<MemoryConsolidationTraceStep, "index">,
): TraceStep[] {
  const retainedSteps = currentSteps.filter((item) => item.type !== "memory_consolidation");
  return [
    ...retainedSteps,
    { ...step, index: retainedSteps.length },
  ];
}

/**
 * 异步阶段结束后给已落库的主 Trace 追加步骤。
 * request_id 当前没有唯一约束，因此只在 user + request 精确命中一行时更新。
 */
export async function appendMemoryConsolidationTraceStep(
  requestId: string,
  userId: string | undefined,
  step: Omit<MemoryConsolidationTraceStep, "index">,
): Promise<void> {
  if (!hasSupabaseConfig() || !userId) return;
  const supabase = getSupabase();

  for (const delayMs of APPEND_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const { data, error } = await supabase
      .from("agent_traces")
      .select("id, steps")
      .eq("request_id", requestId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(2);
    if (error) {
      console.error("[appendMemoryConsolidationTraceStep] 读取 Trace 失败:", error.message);
      return;
    }
    if (!data || data.length === 0) continue;
    if (data.length !== 1) {
      console.error("[appendMemoryConsolidationTraceStep] requestId 命中多条 Trace，拒绝更新", {
        requestId,
        count: data.length,
      });
      return;
    }

    const currentSteps = Array.isArray(data[0].steps)
      ? data[0].steps as TraceStep[]
      : [];
    // 同一请求只保留最新的记忆固化结果，避免函数重试造成重复时间线节点。
    const nextSteps = mergeMemoryConsolidationTraceStep(currentSteps, step);
    const { error: updateError } = await supabase
      .from("agent_traces")
      .update({
        steps: redactSensitiveValue(nextSteps),
      })
      .eq("id", data[0].id)
      .eq("user_id", userId);
    if (updateError) {
      console.error("[appendMemoryConsolidationTraceStep] 更新 Trace 失败:", updateError.message);
    }
    return;
  }

  console.error("[appendMemoryConsolidationTraceStep] 主 Trace 尚未落库，放弃追加", {
    requestId,
  });
}

function isMissingRetentionColumn(error: { code?: string; message?: string }) {
  return error.code === "PGRST204"
    || error.message?.includes("retention_until") === true
    || error.message?.includes("schema cache") === true;
}
