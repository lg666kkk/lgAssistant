import { describe, expect, it } from "vitest";
import { arrangeTraceSteps } from "./trace-steps";

const model = (index: number, id: string) => ({ type: "model", index, requestedToolCalls: [{ id, name: "web_search" }] });
const tool = (index: number, toolCallId?: string) => ({ type: "tool", index, name: "web_search", toolCallId });

describe("trace step presentation", () => {
  it("preserves chronology when multiple rounds call the same tool", () => {
    const steps = [model(0, "call-1"), tool(1, "call-1"), model(2, "call-2"), tool(3, "call-2")];
    expect(arrangeTraceSteps(steps)).toEqual(steps.map((step) => ({ step, nested: step.type === "tool" })));
  });

  it("does not move continuation executions across context or plan steps", () => {
    const steps = [model(0, "call-1"), { type: "plan", index: 1 }, tool(2, "call-1"), { type: "context_compaction", index: 3 }, model(4, "call-2")];
    const arranged = arrangeTraceSteps(steps);
    expect(arranged.map(({ step }) => step)).toEqual(steps);
    expect(arranged[2].nested).toBe(true);
  });

  it("does not attach unmatched call IDs by tool name", () => {
    expect(arrangeTraceSteps([model(0, "call-1"), tool(1, "unknown")])[1].nested).toBe(false);
  });

  it("uses only the preceding model for legacy tools without IDs", () => {
    const steps = [tool(0), model(1, "call-1"), tool(2), { type: "model", index: 3, requestedToolCalls: [] }, tool(4)];
    expect(arrangeTraceSteps(steps).map(({ nested }) => nested)).toEqual([false, false, true, false, false]);
  });
});
