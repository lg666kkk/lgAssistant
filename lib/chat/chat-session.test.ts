import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "./chat-session";
import type { Message as DatabaseMessage, SessionManager } from "./session-manager";

function databaseMessage(index: number): DatabaseMessage {
  return {
    id: `message-${index}`,
    session_id: "session-1",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    created_at: new Date(Date.UTC(2026, 7, 5, 0, index)).toISOString(),
  };
}

function managerWithGetMessages(
  getMessages: SessionManager["getMessages"],
): SessionManager {
  return { getMessages } as SessionManager;
}

describe("ChatSession history loading", () => {
  it("loads only the newest page for an existing session", async () => {
    const page = Array.from({ length: 50 }, (_, index) => databaseMessage(index));
    const getMessages = vi.fn(async () => page);
    const session = new ChatSession(
      "session-1",
      "user-1",
      managerWithGetMessages(getMessages),
    );

    await session.loadFromDatabase();

    expect(getMessages).toHaveBeenCalledWith("session-1", { limit: 50 });
    expect(session.messages).toHaveLength(50);
    expect(session.messages[0]).toMatchObject({
      id: "message-0",
      createdAt: page[0].created_at,
    });
    expect(session.historyLoaded).toBe(true);
    expect(session.hasOlderMessages).toBe(true);
  });

  it("deduplicates concurrent history loads", async () => {
    let resolvePage: (messages: DatabaseMessage[]) => void = () => undefined;
    const pagePromise = new Promise<DatabaseMessage[]>((resolve) => {
      resolvePage = resolve;
    });
    const getMessages = vi.fn(() => pagePromise);
    const session = new ChatSession(
      "session-1",
      "user-1",
      managerWithGetMessages(getMessages),
    );

    const first = session.loadFromDatabase();
    const second = session.loadFromDatabase();
    expect(session.historyLoading).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(1);

    resolvePage([databaseMessage(1)]);
    await Promise.all([first, second]);
    expect(session.historyLoading).toBe(false);
  });

  it("prepends older messages and advances the pagination cursor", async () => {
    const newestPage = Array.from({ length: 50 }, (_, index) => databaseMessage(index + 50));
    const olderPage = [databaseMessage(48), databaseMessage(49)];
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce(newestPage)
      .mockResolvedValueOnce(olderPage);
    const session = new ChatSession(
      "session-1",
      "user-1",
      managerWithGetMessages(getMessages),
    );

    await session.loadFromDatabase();
    await session.loadOlderMessages();

    expect(getMessages).toHaveBeenLastCalledWith("session-1", {
      limit: 50,
      before: newestPage[0].created_at,
    });
    expect(session.messages.slice(0, 3).map((message) => message.id)).toEqual([
      "message-48",
      "message-49",
      "message-50",
    ]);
    expect(session.hasOlderMessages).toBe(false);
  });
});
