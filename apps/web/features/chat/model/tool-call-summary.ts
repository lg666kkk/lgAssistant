type ToolCallLike = {
  metadata?: Record<string, unknown>;
};

const SKIPPED_STATUSES = new Set([
  "retrieval_budget_skipped",
  "duplicate_skipped",
]);

const WAITING_STATUSES = new Set([
  "awaiting_user_input",
  "pending_confirmation",
]);

const BLOCKED_STATUSES = new Set([
  "orchestration_prerequisite_missing",
  "blocked",
  "cancelled",
]);

export function summarizeToolCalls(toolCalls: ToolCallLike[]) {
  let skippedCount = 0;
  let waitingCount = 0;
  let blockedCount = 0;

  for (const toolCall of toolCalls) {
    const status = String(toolCall.metadata?.status ?? "");
    if (SKIPPED_STATUSES.has(status)) skippedCount += 1;
    else if (WAITING_STATUSES.has(status)) waitingCount += 1;
    else if (BLOCKED_STATUSES.has(status)) blockedCount += 1;
  }

  return {
    requestedCount: toolCalls.length,
    executedCount: toolCalls.length - skippedCount - waitingCount - blockedCount,
    skippedCount,
    waitingCount,
    blockedCount,
  };
}
