import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { executeToolCall } from "@/lib/agent/tools/tool-router";
import type { ToolCall } from "@/lib/agent/tools/types";
import { createTrace, finalizeAnswerTrace } from "@/lib/agent/runtime/trace";
import type { ChatApplicationDependencies } from "../chat/ports";
import { createToolObservationProjector } from "../chat/tool-observations";
import { openExternalToolSession } from "./session";

export async function confirmTool(input: {
  userId: string;
  sessionId?: string;
  requestId: string;
  signal: AbortSignal;
  toolCall: ToolCall;
  dependencies: ChatApplicationDependencies;
}) {
  const deps = input.dependencies;
  const external = await openExternalToolSession({
    userId: input.userId, signal: input.signal,
    port: input.toolCall.name.startsWith("mcp_") ? deps.externalTools : undefined,
  });
  try {
    const registry = createBuiltinToolRegistry();
    external.tools.forEach(tool => registry.register(tool));
    return await deps.telemetry.withTrace({
      userId: input.userId, sessionId: input.sessionId, name: "tool-confirmation",
      metadata: { requestId: input.requestId }, tags: ["tool-confirmation"],
    }, async ({ trace: remoteTrace }) => {
      const trace = createTrace(input.requestId, input.sessionId);
      const startedAt = Date.now();
      const result = await executeToolCall(registry, input.toolCall, {
        approved: true, userId: input.userId, scopeId: input.sessionId,
        requestId: input.requestId, signal: external.signal,
      });
      const durationMs = Date.now() - startedAt;
      trace.steps.push({
        type: "tool", index: 0, startedAt, durationMs,
        name: input.toolCall.name, toolCallId: input.toolCall.id, input: input.toolCall.input,
        ok: result.ok, contentSummary: result.content.slice(0, 1200),
        contentTruncated: result.content.length > 1200, contentOriginalChars: result.content.length,
        error: result.error, metadata: { ...result.metadata, confirmed: true }, costPerUse: 0,
      });
      trace.completed = result.ok;
      trace.stopReason = result.ok ? "completed" : "error";
      trace.metrics.toolCallCount = 1;
      trace.metrics.toolDurations = [{ name: input.toolCall.name, durationMs }];
      finalizeAnswerTrace(trace);
      createToolObservationProjector(remoteTrace, input.requestId)(trace);
      remoteTrace.setTraceIO({ input: { toolCallId: input.toolCall.id }, output: { ok: result.ok } });
      await deps.traces.save(trace, input.userId).catch(() => console.error("[trace] 确认执行记录保存失败"));
      return { ...result, metadata: { ...result.metadata, confirmationRequestId: input.requestId } };
    });
  } finally {
    await external.close();
  }
}
