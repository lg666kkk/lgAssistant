import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { ChatSession } from "./chat-session";
import type { SessionManager } from "./session-manager";
vi.mock("@web/lib/auth/client", () => ({
  getAccessToken: vi.fn(async () => null),
  authFetch: vi.fn(),
}));
vi.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: vi.fn(),
  EventStreamContentType: "text/event-stream",
}));
beforeEach(() => vi.clearAllMocks());
function setup() {
  const manager = {
    updateAssistantMessage: vi.fn(async () => {}),
    saveAssistantMessage: vi.fn(async () => ({
      id: "continued",
      created_at: "now",
    })),
  } as unknown as SessionManager;
  const session = new ChatSession("session", "alice", manager);
  session.messages = [
    {
      id: "message",
      role: "assistant",
      content: "请确认",
      toolCalls: [
        {
          id: "call",
          name: "mcp_tool",
          input: { value: "client tamper" },
          ok: false,
          content: "pending",
          metadata: {
            status: "pending_confirmation",
            confirmationToken: "token",
          },
        },
      ],
    },
  ];
  return { session, manager };
}
describe("confirmation UI flow", () => {
  it("streams the continued response and only sends a server handle", async () => {
    const { session, manager } = setup();
    vi.mocked(fetchEventSource).mockImplementation(async (_url, options) => {
      expect(JSON.parse(String(options!.body))).toEqual({
        token: "token",
        callId: "call",
        sessionId: "session",
        action: "confirm",
      });
      for (const event of [
        {
          type: "tool_call",
          toolCall: {
            id: "call",
            name: "mcp_tool",
            ok: true,
            content: "created",
            metadata: { status: "confirmed" },
          },
        },
        { type: "text", content: "任务已完成" },
        { type: "done" },
      ])
        options!.onmessage!({ id: "", event: "", data: JSON.stringify(event) });
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].content).toBe("请确认\n\n任务已完成");
    });
    await session.confirmToolCall(0, 0, vi.fn());
    expect(session.messages[0].toolCalls![0].metadata?.status).toBe(
      "confirmed",
    );
    expect(manager.saveAssistantMessage).not.toHaveBeenCalled();
    expect(manager.updateAssistantMessage).toHaveBeenCalledWith("message", "请确认\n\n任务已完成", expect.objectContaining({ metadata: expect.objectContaining({ toolCalls: session.messages[0].toolCalls }) }));
    expect(session.loading).toBe(false);
  });
  it("keeps repeated approvals, reasoning and tool records in the original reply, even with newer messages", async () => {
    const { session, manager } = setup();
    const original = session.messages[0];
    original.content = "我来查询。请确认工具调用，确认后我会继续完成任务。";
    session.messages.push({ role: "user", content: "补充信息" });
    vi.mocked(fetchEventSource).mockImplementation(async (_url, options) => {
      expect(session.streamingMessage).toBe(original);
      for (const event of [
        { type: "tool_call", toolCall: { id: "second", name: "mcp_second", ok: false, content: "pending", metadata: { status: "pending_confirmation", confirmationToken: "token2" } } },
        { type: "reasoning", reasoning: { id: "r", modelCallIndex: 2, content: "第一段" } },
        { type: "reasoning", reasoning: { id: "r", modelCallIndex: 2, content: "第二段" } },
        { type: "text", content: "查询完成。" }, { type: "text", content: "还有一个操作需要确认，确认后我会继续。" },
        { type: "done" },
      ]) options!.onmessage!({ id: "", event: "", data: JSON.stringify(event) });
    });
    await session.confirmToolCall(0, 0);
    expect(session.messages).toHaveLength(2);
    expect(original.content).toBe("我来查询。\n\n查询完成。还有一个操作需要确认，确认后我会继续。");
    expect(original.reasoning).toHaveLength(1);
    expect(original.reasoning![0].content).toBe("第一段第二段");
    expect(original.toolCalls).toHaveLength(2);
    vi.mocked(fetchEventSource).mockImplementation(async (_url, options) => {
      options!.onmessage!({ id: "", event: "", data: JSON.stringify({ type: "text", content: "全部完成。" }) });
    });
    await session.confirmToolCall(0, 1);
    expect(session.messages).toHaveLength(2);
    expect(original.content).toBe("我来查询。\n\n查询完成。\n\n全部完成。");
    expect(manager.saveAssistantMessage).not.toHaveBeenCalled();
    expect(manager.updateAssistantMessage).toHaveBeenLastCalledWith("message", original.content, expect.objectContaining({ metadata: expect.objectContaining({ reasoning: original.reasoning, toolCalls: original.toolCalls }) }));
  });

  it("submits a question answer through continuation while retaining the same assistant message", async () => {
    const { session, manager } = setup();
    session.messages[0].toolCalls![0].name = "ask_user";
    vi.mocked(fetchEventSource).mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      expect(body).toMatchObject({ action: "answer", answer: "北京望京", callId: "call" });
      expect(body).not.toHaveProperty("messages");
      options!.onmessage!({ id: "", event: "", data: JSON.stringify({ type: "text", content: "附近有三家门店" }) });
    });
    await session.confirmToolCall(0, 0, vi.fn(), "answer", "北京望京");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].content).toContain("附近有三家门店");
    expect(manager.saveAssistantMessage).not.toHaveBeenCalled();
    expect(manager.updateAssistantMessage).toHaveBeenCalled();
  });

  it("surfaces a server error and leaves the pending call available", async () => {
    const { session } = setup();
    vi.mocked(fetchEventSource).mockImplementation(async (_url, options) => {
      options!.onmessage!({
        id: "",
        event: "",
        data: JSON.stringify({ type: "error", message: "配置已变化" }),
      });
    });
    await session.confirmToolCall(0, 0);
    expect(session.error).toBe("配置已变化");
    expect(session.messages[0].toolCalls![0].metadata?.status).toBe(
      "pending_confirmation",
    );
  });
  it("blocks concurrent clicks", async () => {
    const { session } = setup();
    let resolve!: () => void;
    vi.mocked(fetchEventSource).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = session.confirmToolCall(0, 0);
    await session.confirmToolCall(0, 0);
    expect(fetchEventSource).toHaveBeenCalledTimes(1);
    resolve();
    await first;
  });
  it("sends cancellation to the server and rejects old records", async () => {
    const { session } = setup();
    vi.mocked(fetchEventSource).mockResolvedValue();
    await session.cancelToolCall(0, 0);
    expect(
      JSON.parse(String(vi.mocked(fetchEventSource).mock.calls[0][1]?.body))
        .action,
    ).toBe("cancel");
    session.messages[0].toolCalls![0].metadata = {};
    await session.confirmToolCall(0, 0);
    expect(fetchEventSource).toHaveBeenCalledTimes(1);
    expect(session.error).toContain("旧记录");
  });
});
