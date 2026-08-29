import { describe, expect, it } from "vitest";
import { serializeAgentEvent, type AgentEvent } from "./chat";

describe("chat contracts", () => {
  it("serializes a discriminated event without losing its type", () => {
    const event: AgentEvent = { type: "text", content: "你好" };

    expect(serializeAgentEvent(event)).toBe(
      'event:text\ndata:{"type":"text","content":"你好"}\n\n',
    );
  });

  it("keeps plan execution controls transport-only", () => {
    const event: AgentEvent = {
      type: "plan_proposal",
      plan: {
        id: "plan-1",
        objective: "完成任务",
        steps: [{
          id: "step-1",
          goal: "读取资料",
          allowedTools: ["search_notes"],
          successCriteria: ["返回资料"],
        }],
      },
    };

    expect(JSON.parse(serializeAgentEvent(event).split("data:")[1])).toEqual(event);
  });
});
