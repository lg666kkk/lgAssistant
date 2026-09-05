import type { AgentTrace, ToolTraceStep } from "@/lib/agent/runtime/trace";
import { redactSensitiveText } from "@/lib/agent/rag/governance";
import type { ExternalTracePort } from "./ports";

const PREVIEW_LIMIT = 1200;
const SENSITIVE_KEY = /password|secret|token|authorization|cookie|api.?key|private.?key|credential|bundle|support.?files/i;

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value).replace(
      /((?:password|secret|token|authorization|cookie|api[_-]?key)\s*[=:]\s*)[^\r\n]+/gi,
      "$1[REDACTED]",
    ).slice(0, PREVIEW_LIMIT);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[OMITTED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
    redactSensitiveText(key).slice(0, 100),
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : safeValue(item, depth + 1),
  ]));
}

function preview(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    parsed = serialized;
  }
  const safe = safeValue(parsed);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe) ?? "";
  return {
    preview: text.slice(0, PREVIEW_LIMIT),
    truncated: serialized.length > PREVIEW_LIMIT || text.length > PREVIEW_LIMIT,
  };
}

function skillIdentity(step: ToolTraceStep) {
  if (!["view_skill", "run_skill"].includes(step.name)) return {};
  const input = step.input && typeof step.input === "object"
    ? step.input as Record<string, unknown>
    : {};
  return {
    ...(typeof input.skillId === "string" ? { skillId: safeValue(input.skillId) } : {}),
    ...(typeof input.skillVersion === "string" ? { skillVersion: safeValue(input.skillVersion) } : {}),
  };
}

export function createToolObservationProjector(trace: ExternalTracePort, requestId: string) {
  const projected = new Set<string>();
  return (agentTrace: AgentTrace) => {
    for (const step of agentTrace.steps) {
      if (step.type !== "tool") continue;
      const identity = JSON.stringify([step.index, step.toolCallId, step.name]);
      if (projected.has(identity)) continue;
      projected.add(identity);
      try {
        const status = typeof step.metadata?.status === "string" ? step.metadata.status : (step.ok ? "succeeded" : "failed");
        const input = preview(step.input);
        const output = preview(step.contentSummary);
        const observation = trace.startObservation(`tool:${step.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)}`, {
          input,
          output: {
            ok: step.ok,
            status: safeValue(status),
            contentSummary: output.preview,
            contentTruncated: step.contentTruncated || output.truncated,
            contentOriginalChars: step.contentOriginalChars,
            ...(step.error ? { error: preview(step.error).preview } : {}),
          },
          metadata: {
            requestId,
            toolName: step.name,
            toolCallId: step.toolCallId,
            stepIndex: step.index,
            ...skillIdentity(step),
            measuredDurationMs: step.durationMs,
            recordedAtMs: step.startedAt,
            projectedAfterExecution: true,
          },
          level: step.ok ? "DEFAULT" : status === "failed" ? "ERROR" : "WARNING",
        }, { asType: "tool" });
        observation.end();
      } catch {
        console.error("[langfuse] 工具步骤上报失败，跳过");
      }
    }
  };
}
