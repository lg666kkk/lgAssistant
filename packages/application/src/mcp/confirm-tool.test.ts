import { describe, expect, it, vi } from "vitest";
import { confirmTool } from "./confirm-tool";
import {
  checkpoint,
  toolFingerprint,
  type Continuation,
  type ConfirmationResponse,
} from "./continuation";
import { ToolRegistry } from "@/lib/agent/tools/registry";
import { askUserTool } from "@/lib/agent/tools/ask-user";
import { adaptMcpTool } from "@/lib/agent/tools/mcp-adapter";
import { createTrace } from "@/lib/agent/runtime/trace";
import type { ChatApplicationDependencies } from "../chat/ports";
import type { AgentLoopResult } from "@/lib/agent/runtime";

function setup() {
  const call = vi.fn(async () => ({
    content: [{ type: "text", text: "created campaign 42" }],
  }));
  const tool = adaptMcpTool({
    serverId: "service",
    serverName: "营销服务",
    configurationRevision: "v1",
    userId: "alice",
    tool: { name: "create", inputSchema: { type: "object" } },
    policy: {
      name: "create",
      riskLevel: "confirm",
      sideEffect: "write",
      timeoutSeconds: 5,
    },
    call,
  });
  const state: Continuation = {
    requestId: "original",
    sessionId: "session",
    model: "model-1",
    tools: [tool.name],
    system: "Original instructions",
    remainingIterations: 4,
    evidenceBundles: [],
    capabilities: [],
    fingerprints: { "call-1": toolFingerprint(tool) },
    pending: [
      {
        id: "call-1",
        name: tool.name,
        input: { title: "Summer" },
        ok: false,
        content: "pending",
        metadata: { status: "pending_confirmation" },
      },
    ],
    messages: [
      { role: "user", content: "Create and summarize" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: tool.name,
            input: { title: "Summer" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "pending",
            is_error: true,
          },
        ],
      },
    ],
  };
  let saved: ConfirmationResponse | undefined;
  const save = vi.fn(async (_u, _t, _s, _id, response) => {
    saved = response;
  });
  const claim = vi.fn(async () => ({ state, response: saved }));
  const close = vi.fn(async () => {});
  const remote = {
    update: vi.fn(),
    setTraceIO: vi.fn(),
    startObservation: vi.fn(() => ({ update: vi.fn(), end: vi.fn() })),
  };
  const deps = {
    externalTools: { open: vi.fn(async () => ({ tools: [tool], close })) },
    confirmations: {
      claim,
      save,
      release: vi.fn(async () => {}),
      create: vi.fn(async () => "next-token"),
    },
    userContext: { resolveModel: vi.fn(async () => ({})) },
    sessions: {
      createSnapshot: vi.fn(() => ({})),
      saveSnapshot: vi.fn(async () => {}),
      persistTurn: vi.fn(async () => {}),
    },
    traces: { save: vi.fn(async () => {}) },
    telemetry: {
      withTrace: vi.fn(
        async (
          _i: unknown,
          callback: (scope: { trace: typeof remote }) => Promise<unknown>,
        ) => callback({ trace: remote }),
      ),
    },
  } as unknown as ChatApplicationDependencies;
  const resumed: AgentLoopResult = {
    loopMessages: [
      ...state.messages,
      { role: "assistant", content: "Campaign created, here is the summary." },
    ],
    completed: true,
    stopReason: "completed",
    metrics: createTrace("r").metrics,
    trace: createTrace("r"),
  };
  const runAgentLoop = vi.fn(async () => resumed);
  const runtime = {
    runAgentLoop,
    executePlan: vi.fn(async () => resumed),
    streamModelResponse: vi.fn(),
    forwardTextStream: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof confirmTool>[1]>;
  const input = {
    userId: "alice",
    sessionId: "session",
    token: "token-1",
    callId: "call-1",
    action: "confirm" as const,
    signal: new AbortController().signal,
    dependencies: deps,
  };
  return {
    input,
    deps,
    state,
    tool,
    call,
    runtime,
    runAgentLoop,
    resumed,
    close,
    remote,
    save,
  };
}

describe("confirmation continuation", () => {
  it("creates a restorable checkpoint for questions rather than treating them as completed calls", () => {
    const f = setup();
    const registry = new ToolRegistry(); registry.register(askUserTool);
    f.resumed.stopReason = "awaiting_user_input";
    f.resumed.trace.steps = [{ type: "tool", index: 0, startedAt: 0, name: "ask_user", input: { question: "位置？" }, toolCallId: "question-1", ok: true, contentSummary: "等待回答", contentTruncated: false, contentOriginalChars: 4, costPerUse: 0, metadata: { status: "awaiting_user_input", question: "位置？" } }];
    const saved = checkpoint(f.state, f.resumed, registry);
    expect(saved.pending[0]).toMatchObject({ id: "question-1", name: "ask_user" });
    expect(saved.fingerprints["question-1"]).toBeTruthy();
  });

  it("feeds an ask_user answer back as the original tool result without a new user prompt", async () => {
    const f = setup();
    f.state.pending[0].name = "ask_user";
    f.state.pending[0].metadata = { status: "awaiting_user_input", questions: [{ question: "位置？" }] };
    const count = f.state.messages.length;
    const response = await confirmTool({ ...f.input, action: "answer", answer: "北京望京" }, f.runtime);
    expect(f.call).not.toHaveBeenCalled();
    const messages = vi.mocked(f.runtime.runAgentLoop).mock.calls[0][0];
    expect(messages).toHaveLength(count);
    expect(messages[2].content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "call-1", is_error: false, content: expect.stringContaining("北京望京") })]);
    expect(response.events).toContainEqual(expect.objectContaining({ type: "tool_call", toolCall: expect.objectContaining({ name: "ask_user", metadata: expect.objectContaining({ status: "answered", answer: "北京望京" }) }) }));
  });
  it("rejects answers submitted to write confirmations", async () => {
    const f = setup();
    await expect(confirmTool({ ...f.input, action: "answer", answer: "yes" }, f.runtime)).rejects.toThrow("回答无效");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("executes once, feeds the real result and original tool ID back to the loop, returns an answer and records linked traces", async () => {
    const f = setup();
    const response = await confirmTool(f.input, f.runtime);
    expect(f.call).toHaveBeenCalledTimes(1);
    const args = vi.mocked(f.runtime.runAgentLoop).mock.calls[0];
    expect(args[0][2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "created campaign 42",
        is_error: false,
      },
    ]);
    expect(args[9]).toBe("Original instructions");
    expect(args[11]).toBe("model-1");
    expect(response.events).toContainEqual({
      type: "text",
      content: "Campaign created, here is the summary.",
    });
    expect(f.remote.startObservation).toHaveBeenCalled();
    expect(f.deps.telemetry.withTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ parentRequestId: "original" }),
      }),
      expect.any(Function),
    );
    expect(f.deps.sessions.saveSnapshot).toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await confirmTool(f.input, f.runtime)).toEqual(response);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.runAgentLoop).toHaveBeenCalledTimes(1);
  });
  it("rejects a different session and configuration changes before execution", async () => {
    const f = setup();
    await expect(
      confirmTool({ ...f.input, sessionId: "other" }, f.runtime),
    ).rejects.toThrow("当前会话");
    f.tool.configurationRevision = "v2";
    await expect(confirmTool(f.input, f.runtime)).rejects.toThrow("配置已变化");
    expect(f.call).not.toHaveBeenCalled();
    expect(f.deps.confirmations!.release).toHaveBeenCalled();
  });
  it("waits for other approvals in the batch and does not run the model prematurely", async () => {
    const f = setup();
    f.state.pending.push({ ...f.state.pending[0], id: "call-2" });
    const result = await confirmTool(f.input, f.runtime);
    expect(result.pending).toBe(true);
    expect(f.runAgentLoop).not.toHaveBeenCalled();
  });
  it("cancels without calling the tool and continues with a cancellation result", async () => {
    const f = setup();
    await confirmTool({ ...f.input, action: "cancel" }, f.runtime);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(vi.mocked(f.runtime.runAgentLoop).mock.calls[0][0]),
    ).toContain("用户已取消");
  });
  it("caches execution after continuation failure, so retry never repeats the write", async () => {
    const f = setup();
    f.runAgentLoop.mockRejectedValue(new Error("model unavailable"));
    const response = await confirmTool(f.input, f.runtime);
    expect(response.continuationError).toContain("勿重复执行");
    expect(await confirmTool(f.input, f.runtime)).toEqual(response);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("keeps the claim locked if execution result persistence fails", async () => {
    const f = setup();
    f.save.mockRejectedValue(new Error("redis offline"));
    await expect(confirmTool(f.input, f.runtime)).rejects.toThrow();
    expect(f.deps.confirmations!.release).not.toHaveBeenCalled();
  });
  it("resumes a paused plan at its current step rather than rerunning completed steps", async () => {
    const f = setup();
    f.state.plan = { id: "p", objective: "task", steps: [] } as any;
    f.state.planStep = 2;
    await confirmTool(f.input, f.runtime);
    expect(f.runtime.executePlan).toHaveBeenCalledWith(
      expect.objectContaining({ model: "model-1" }),
      f.state.plan,
      { startAtStep: 2 },
    );
    expect(f.runAgentLoop).not.toHaveBeenCalled();
  });
  it("issues a new server checkpoint for a subsequent approval", async () => {
    const f = setup();
    f.resumed.stopReason = "awaiting_tool_confirmation";
    f.resumed.trace.steps = [
      {
        type: "tool",
        index: 0,
        startedAt: 0,
        name: f.tool.name,
        input: { title: "Next" },
        toolCallId: "call-2",
        ok: false,
        contentSummary: "pending",
        contentTruncated: false,
        contentOriginalChars: 7,
        costPerUse: 0,
        metadata: { status: "pending_confirmation" },
      },
    ];
    const result = await confirmTool(f.input, f.runtime);
    expect(result.pending).toBe(true);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        toolCall: expect.objectContaining({
          id: "call-2",
          metadata: expect.objectContaining({
            confirmationToken: "next-token",
          }),
        }),
      }),
    );
  });
});
