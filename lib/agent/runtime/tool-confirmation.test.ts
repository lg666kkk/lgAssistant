import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { defaultToolRuntimePolicy } from "@/lib/agent/tools/types";
import { callModel, runAgentLoop } from "./index";

describe("工具确认暂停", () => {
  it("待确认写工具出现后立即停止，不再让模型发起 ask_user", async () => {
    const execute = vi.fn(async () => ({ ok: true, content: "created" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "create_todo",
      description: "create todo",
      capabilities: ["todo.create"],
      outputPolicy: { grounding: "action_receipt", citationRequired: false },
      input_schema: { type: "object", properties: {} },
      riskLevel: "confirm",
      runtime: {
        ...defaultToolRuntimePolicy,
        sideEffect: "write",
        requiresConfirmation: true,
      },
      execute,
    });
    const callModelMock = vi.fn().mockResolvedValue({
      content: [{
        type: "tool_use",
        id: "todo-1",
        name: "create_todo",
        input: { title: "提交周报" },
      }],
      stop_reason: "tool_use",
    });

    const result = await runAgentLoop(
      [{ role: "user", content: "创建一个提交周报的待办" }],
      registry.listForModel(),
      registry,
      4,
      [],
      () => true,
      "request-confirm",
      "session-confirm",
      { callModel: callModelMock as unknown as typeof callModel },
    );

    expect(result.stopReason).toBe("awaiting_tool_confirmation");
    expect(result.completed).toBe(true);
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
