import { describe, expect, it, vi } from "vitest";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { ChatSession } from "./chat-session";
import type { SessionManager } from "./session-manager";

vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource: vi.fn(), EventStreamContentType: "text/event-stream" }));
vi.mock("@web/lib/auth/client", () => ({ getAccessToken: vi.fn().mockResolvedValue(null), authFetch: vi.fn() }));

describe("automatic plan streaming", () => {
  it("stores a started plan with progress and persists it for recovery without a review state", async () => {
    const plan = {
      id: "plan-auto", objective: "完成报告", steps: [
        { id: "read", goal: "读取资料", allowedTools: ["view_skill"], successCriteria: ["已读取"] },
        { id: "write", goal: "生成报告", allowedTools: [], successCriteria: ["已生成"] },
      ],
    };
    const saveAssistantMessage = vi.fn().mockResolvedValue({ id: "assistant-1", created_at: "2026-09-05T00:00:00Z" });
    const manager = {
      saveUserMessage: vi.fn().mockResolvedValue({ id: "user-1" }),
      updateSessionTitle: vi.fn(), saveAssistantMessage,
    } as unknown as SessionManager;
    const session = new ChatSession("session-1", "user-1", manager);
    vi.mocked(fetchEventSource).mockImplementationOnce(async (_url, options) => {
      options?.onmessage?.({ id: "", event: "plan_started", data: JSON.stringify({ type: "plan_started", plan }) });
      const message = session.messages[1];
      expect(message.plan).toEqual(plan);
      expect(message.planSteps).toHaveLength(2);
      expect(message.planSteps?.[0]).toMatchObject({ stepId: "read", status: "pending" });
      options?.onmessage?.({ id: "", event: "plan_progress", data: JSON.stringify({
        type: "plan_progress", plan: { ...message.planSteps![0], status: "failed", failureReason: "读取失败" },
      }) });
      options?.onmessage?.({ id: "", event: "text", data: JSON.stringify({ type: "text", content: "读取失败，可以重试。" }) });
    });
    await session.send("完成报告", vi.fn());
    expect(session.error).toBeNull();
    expect(session.messages[1].planSteps?.[0].status).toBe("failed");
    expect(saveAssistantMessage).toHaveBeenCalledWith("session-1", expect.any(String), expect.objectContaining({
      metadata: expect.objectContaining({ plan, planSteps: expect.arrayContaining([expect.objectContaining({ stepId: "read", status: "failed" })]) }),
    }));
  });
});
