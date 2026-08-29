import type {
  ChatTelemetryPort,
  ExternalTracePort,
} from "@repo/application/chat/ports";
import { reportOnlineScores } from "@/lib/agent/eval/online-scores";
import { withUserLangfuseTrace } from "@/lib/langfuse/client";

export function createChatTelemetryAdapter(): ChatTelemetryPort {
  return {
    withTrace: (input, callback) => withUserLangfuseTrace(
      input,
      (trace, client) => callback({
        trace: trace as ExternalTracePort,
        reportOnlineScores: (agentTrace) => {
          if (!trace.id) return Promise.resolve();
          return reportOnlineScores({
            traceId: trace.id,
            trace: agentTrace,
            scoreClient: client ?? undefined,
          });
        },
      }),
    ),
  };
}
