type StepForDisplay = {
  type: string;
  index: number;
  name?: string;
  toolCallId?: string;
  requestedToolCalls?: Array<{ id: string; name: string }>;
};

/** Indent executions belonging to a model call without changing the trace timeline. */
export function arrangeTraceSteps<T extends StepForDisplay>(steps: T[]): Array<{ step: T; nested: boolean }> {
  const requestedIds = new Set(steps.flatMap((step) => step.type === "model"
    ? (step.requestedToolCalls ?? []).map((call) => call.id)
    : []));
  let precedingModel: T | undefined;
  return steps.map((step) => {
    if (step.type === "model") precedingModel = step;
    const nested = step.type === "tool" && (step.toolCallId
      ? requestedIds.has(step.toolCallId)
      : Boolean(precedingModel?.requestedToolCalls?.some((call) => call.name === step.name)));
    return { step, nested };
  });
}
