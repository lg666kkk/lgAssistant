type StepForDisplay = {
  type: string;
  index: number;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  requestedToolCalls?: Array<{ id: string; name: string }>;
};

/** Keep final executions in chronological order, folding earlier approval checkpoints. */
export function arrangeTraceSteps<T extends StepForDisplay>(steps: T[]): Array<{ step: T; nested: boolean; confirmationSteps?: T[] }> {
  const requestedIds = new Set(steps.flatMap((step) => step.type === "model"
    ? (step.requestedToolCalls ?? []).map((call) => call.id)
    : []));
  let precedingModel: T | undefined;
  const pending = new Map<string, T[]>();
  const folded = new Set<T>();
  const arranged = steps.map((step) => {
    if (step.type === "model") precedingModel = step;
    const nested = step.type === "tool" && (step.toolCallId
      ? requestedIds.has(step.toolCallId)
      : Boolean(precedingModel?.requestedToolCalls?.some((call) => call.name === step.name)));
    const row: { step: T; nested: boolean; confirmationSteps?: T[] } = { step, nested };
    if (step.type === "tool" && step.toolCallId) {
      const key = JSON.stringify([step.name, step.toolCallId]);
      if (step.metadata?.status === "pending_confirmation") {
        pending.set(key, [...(pending.get(key) ?? []), step]);
      } else if (pending.has(key)) {
        row.confirmationSteps = pending.get(key)!;
        row.confirmationSteps.forEach((checkpoint) => folded.add(checkpoint));
        pending.delete(key);
      }
    }
    return row;
  });
  return arranged.filter(({ step }) => !folded.has(step));
}
