import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { createBuiltinToolRegistry } from "@/lib/agent/tools/builtin";
import { defaultToolRuntimePolicy } from "@/lib/agent/tools/types";
import { callModel, runAgentLoop } from "./index";

describe("工具确认暂停", () => {
  it("聊天请求终端命令时先暂停等待用户确认", async () => {
    const registry = createBuiltinToolRegistry();
    const model = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "terminal-1", name: "run_terminal_command", input: { command: "npx skills find finance" } }],
      stop_reason: "tool_use",
    });
    const result = await runAgentLoop(
      [{ role: "user", content: "用终端查找 finance skill" }],
      registry.listForModel(), registry, 4, [], () => true,
      "request-terminal", "session-terminal",
      { callModel: model as unknown as typeof callModel },
    );
    expect(result.stopReason).toBe("awaiting_tool_confirmation");
    expect(model).toHaveBeenCalledTimes(1);
  });

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

describe("恢复工具确认后的循环", () => {
  it("模型收到原始调用 ID 对应的真实结果后，可以继续生成答案", async () => {
    const registry = new ToolRegistry();
    const model = vi.fn(async (messages: unknown) => {
      expect(JSON.stringify(messages)).toContain("created-42");
      expect(JSON.stringify(messages)).toContain("call-original");
      return { content: [{ type: "text", text: "操作完成，记录编号 42。" }], stop_reason: "end_turn" };
    });
    const messages = [
      { role: "user" as const, content: "创建记录并告诉我编号" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "call-original", name: "create_todo", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "call-original", content: "created-42", is_error: false }] },
    ];
    const result = await runAgentLoop(messages, [], registry, 2, [], () => true, "continuation", "session", { callModel: model as unknown as typeof callModel });
    expect(result.completed).toBe(true);
    expect(JSON.stringify(result.loopMessages)).toContain("操作完成");
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("恢复后模型重复请求已执行操作时，不会再次执行", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ ok: true, content: "created" }));
    registry.register({ name: "create", description: "create", capabilities: [], input_schema: { type: "object" }, outputPolicy: { grounding: "action_receipt", citationRequired: false }, riskLevel: "safe", runtime: defaultToolRuntimePolicy, execute });
    const toolUse = { type: "tool_use" as const, id: "duplicate", name: "create", input: { title: "same" } };
    const { getToolCallKey } = await import("./index");
    const model = vi.fn().mockResolvedValue({ content: [toolUse], stop_reason: "tool_use" });
    const result = await runAgentLoop([{ role: "user", content: "continue" }], registry.listForModel(), registry, 2, [], () => true, "continuation", "s", { callModel: model as unknown as typeof callModel }, undefined, undefined, undefined, undefined, undefined, undefined, [], undefined, [], undefined, new Map(), undefined, { executedToolKeys: [getToolCallKey(toolUse)] });
    expect(result.stopReason).toBe("repeated_tool_call");
    expect(execute).not.toHaveBeenCalled();
  });
});
