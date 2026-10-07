import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@web/lib/auth/client";
import { ChatSession } from "./chat-session";
import type { SessionManager } from "./session-manager";

vi.mock("@web/lib/auth/client", () => ({ authFetch: vi.fn(), getAccessToken: vi.fn() }));
function setup(id?: string) {
  const manager = {
    createSession: vi.fn().mockResolvedValue({}),
    saveUserMessage: vi.fn().mockResolvedValue({ id: "user-command", created_at: "2026-10-06T00:00:00Z" }),
    saveAssistantMessage: vi.fn().mockResolvedValue({ id: "command-result", created_at: "2026-10-06T00:00:01Z" }),
  };
  const session = new ChatSession(id, "user-1", manager as unknown as SessionManager);
  return { session, manager };
}
beforeEach(() => { vi.clearAllMocks(); });

describe("compact command messages", () => {
  it("shows the command and running status immediately and persists the completion", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(authFetch).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { session, manager } = setup("existing-session");
    const update = vi.fn();
    const operation = session.compactContext("model-1", update);
    expect(session.compacting).toBe(true);
    expect(session.messages[0]).toMatchObject({ role: "user", command: "compact" });
    expect(session.messages[1]).toMatchObject({ role: "assistant", commandState: "running" });
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce());
    await session.compactContext("model-1", update);
    expect(session.messages).toHaveLength(2);
    resolve(Response.json({ compacted: true, message: "上下文已压缩：1000 → 500 tokens" }));
    await operation;
    expect(session.compacting).toBe(false);
    expect(session.messages[1]).toMatchObject({ commandState: "completed", content: "上下文已压缩：1000 → 500 tokens" });
    expect(session.contextRevision).toBe(1);
    expect(manager.saveAssistantMessage).toHaveBeenCalledWith("existing-session", expect.any(String),
      expect.objectContaining({ metadata: expect.objectContaining({ command: "compact", commandState: "completed", durationMs: expect.any(Number) }) }));
  });

  it("renders an empty-session result without calling the compression API", async () => {
    const { session, manager } = setup();
    await session.compactContext("model-1", vi.fn());
    expect(manager.createSession).toHaveBeenCalledOnce();
    expect(authFetch).not.toHaveBeenCalled();
    expect(session.messages[1]).toMatchObject({ commandState: "completed", content: "当前会话暂无上下文可压缩。" });
  });

  it("shows and persists a failure and releases the busy state", async () => {
    vi.mocked(authFetch).mockResolvedValue(Response.json({ error: "会话正在处理请求" }, { status: 409 }));
    const { session } = setup("existing-session");
    await session.compactContext("model-1", vi.fn());
    expect(session.messages[1]).toMatchObject({ commandState: "failed", content: "会话正在处理请求" });
    expect(session.compacting).toBe(false);
    expect(session.compactionStartedAt).toBeNull();
  });
});
